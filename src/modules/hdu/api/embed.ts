import 'server-only';
import * as z from 'zod';
import type { ClientActor } from '@/db/with-actor';
import { getEnv } from '@/env';
import { logEvent } from '@/lib/log';
import { clientIp, consumeRateLimit, ipBucket, isSameOriginJson, peekRateLimit, problemResponse, rateKey, readLimited } from '@/modules/hdc/api';
import { RATE_RULES } from '@/modules/hdc/pref';
import { contextKeySource } from '../core/context-keys';
import { ContextRejected, unverifiedIssuer, verifyContextToken } from '../core/context-token';
import { embedMembership, findOrCreateSmartupUser, noteEmbedSession, rememberContextToken } from '../core/embed';
import { type EmbedClaims, EmbedTokenInvalid, signEmbedToken, verifyEmbedToken } from '../core/embed-token';
import { provisionFromSmartup } from '../core/provision';
import { readContextServer } from '../core/servers';
import { HduError } from '../error';
import { CONTEXT_CLOCK_TOLERANCE_SEC, type ContextPlatform, EMBED_TOKEN_TTL_SEC } from '../pref';

// Сессия виджета (ТЗ 11.4; план M6, задача 2; решения 1, 4, 5, 14, 15 и 16).
//
// POST /api/embed/session: страница виджета в iframe присылает токен контекста, который выпустил сервер Smartup,
// и получает токен виджета на 15 минут. Токен виджета живёт только в памяти страницы, кук нет ни в ответе, ни в запросе.
// Каждый следующий запрос виджета несёт токен в заголовке Authorization; requireEmbedActor строит по нему актора клиента
// и на каждом запросе проверяет членство, организацию и сервер в базе.
//
// Организация и пользователь берутся только из проверенного токена контекста (сервер из реестра по iss, подпись его
// ключом), затем только из проверенного токена виджета. Подсказки страницы (модуль, экран, ошибка) сюда не попадают.

const NO_STORE = { 'Cache-Control': 'no-store' };
const MAX_BODY_BYTES = 16 * 1024;
const sessionInput = z.object({ contextToken: z.string().min(1).max(8192) }).strict();

/** Кто перед нами в запросе виджета: актор клиента, сервер Smartup и платформа из токена. */
export type EmbedContext = { actor: ClientActor; serverId: string; serverCode: string; platform: ContextPlatform };

type EmbedConfig = { secret: string; issuer: string };

/** Секрет токена виджета и адрес портала. Без секрета виджет выключен (на настоящем адресе его требует src/env.ts). */
function embedConfig(): EmbedConfig | null {
  const env = getEnv();
  return env.EMBED_TOKEN_SECRET ? { secret: env.EMBED_TOKEN_SECRET, issuer: env.HUB_URL } : null;
}

const BEARER = /^Bearer ([A-Za-z0-9_.-]{1,4096})$/;

/** Проверенный токен виджета из заголовка Authorization без обращения к базе. Нет или не принят: null. */
async function bearerClaims(request: Request, cfg: EmbedConfig): Promise<EmbedClaims | null> {
  const match = BEARER.exec(request.headers.get('authorization') ?? '');
  if (!match?.[1]) return null;
  try {
    return await verifyEmbedToken(match[1], cfg);
  } catch (error) {
    if (error instanceof EmbedTokenInvalid) return null;
    throw error;
  }
}

/**
 * Актор клиента запроса виджета. Нет токена, подпись, срок, получатель или издатель не те: unauthenticated (401,
 * страница просит у хозяина новый токен контекста). Участник или организация отключены, сервер отключён, человек
 * стал сотрудником: forbidden (403). Сессия портала (кука) здесь не читается никогда.
 */
export async function requireEmbedActor(request: Request): Promise<EmbedContext> {
  const cfg = embedConfig();
  if (!cfg) throw new HduError('unauthenticated');
  const claims = await bearerClaims(request, cfg);
  if (!claims) throw new HduError('unauthenticated');
  const member = await embedMembership(claims.userId, claims.orgId, claims.serverId);
  if (!member) throw new HduError('forbidden');
  return {
    actor: { type: 'client', userId: claims.userId, orgId: claims.orgId, orgRole: member.role, ip: clientIp(request.headers) },
    serverId: claims.serverId,
    serverCode: member.serverCode,
    platform: claims.platform,
  };
}

/** В запросе есть заголовок Authorization со схемой Bearer: это запрос виджета, сессия портала не читается. */
export function hasBearer(request: Request): boolean {
  return /^Bearer\s/i.test(request.headers.get('authorization') ?? '');
}

const UNAUTHENTICATED_HEADERS = { 'WWW-Authenticate': 'Bearer', 'Cache-Control': 'no-store' };

/**
 * Актор запроса виджета или готовый ответ отказа: 401 (страница просит у хозяина новый токен контекста) или 403.
 * Для обработчиков, которые принимают и сессию портала, и токен виджета (загрузки, вложения).
 */
export async function embedRequestActor(request: Request): Promise<EmbedContext | { denied: Response }> {
  try {
    return await requireEmbedActor(request);
  } catch (error) {
    if (!(error instanceof HduError)) throw error;
    if (error.code === 'forbidden') return { denied: problemResponse(403, 'forbidden', { 'Cache-Control': 'no-store' }) };
    return { denied: problemResponse(401, 'unauthenticated', UNAUTHENTICATED_HEADERS) };
  }
}

const EMBED_BODY_BYTES = 64 * 1024;

/**
 * Общая часть обработчиков API виджета (/api/embed/*, /api/suggest): токен виджета в заголовке Authorization (сессия
 * портала и куки не читаются никогда), тело только JSON до 64 КБ, ответ без кеша. Кук обработчики не ставят.
 * Организация и пользователь только из проверенного токена: тело запроса их не задаёт.
 */
export async function withEmbedRequest(request: Request, run: (ctx: EmbedContext, body: unknown) => Promise<Response>): Promise<Response> {
  const embed = await embedRequestActor(request);
  if ('denied' in embed) return embed.denied;
  let body: unknown = null;
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    const type = request.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase();
    if (type !== 'application/json') return problemResponse(415, 'invalid_input');
    const text = await readLimited(request, EMBED_BODY_BYTES);
    if (text === null) return problemResponse(413, 'too_large');
    try {
      body = JSON.parse(text);
    } catch {
      return problemResponse(400, 'invalid_input');
    }
  }
  const response = await run(embed, body);
  response.headers.set('Cache-Control', 'no-store');
  response.headers.delete('set-cookie');
  return response;
}

type Exchange = { embedToken: string } | { denied: 'forbidden' } | { denied: 'rate_limited'; retryAfterSec: number };

/** Обмен проверенного по подписи токена контекста. Отказы проверки бросают ContextRejected. */
async function exchange(token: string, cfg: EmbedConfig, current: EmbedClaims | null, ip: string | null): Promise<Exchange> {
  const server = await readContextServer(unverifiedIssuer(token));
  if (!server) throw new ContextRejected('unknown_issuer');
  const claims = await verifyContextToken(token, server, contextKeySource());

  const perUser = await consumeRateLimit(rateKey('embed-session:user', `${server.serverId}:${claims.sub}`), RATE_RULES.embedSessionPerUser);
  if (!perUser.allowed) return { denied: 'rate_limited', retryAfterSec: perUser.retryAfterSec };
  // Одноразовость: пара "сервер и jti". Строка нужна до срока токена с допуском часов.
  if (!(await rememberContextToken(server.serverId, claims.jti, new Date((claims.exp + CONTEXT_CLOCK_TOLERANCE_SEC) * 1000))))
    throw new ContextRejected('replayed');

  // Тот же человек, что при входе OAuth: пара "сервер и sub". Организация: пара "сервер и company_id" этого сервера.
  const user = await findOrCreateSmartupUser(server.code, claims.sub, claims.profile.name ?? '');
  if (user.isStaff) return { denied: 'forbidden' };
  const provisioned = await provisionFromSmartup(user.userId, server.code, claims.profile);
  if ('failed' in provisioned) throw new ContextRejected('claims');
  const member = await embedMembership(user.userId, provisioned.orgId, server.serverId);
  if (!member) return { denied: 'forbidden' };

  const embedToken = await signEmbedToken({ userId: user.userId, orgId: provisioned.orgId, serverId: server.serverId, platform: claims.platform }, cfg);
  // Новая сессия в журнал аудита, продление действующей только в журнал работы (решение 15).
  const renewal = current !== null && current.userId === user.userId && current.orgId === provisioned.orgId && current.serverId === server.serverId;
  if (!renewal) await noteEmbedSession({ userId: user.userId, orgId: provisioned.orgId, serverCode: server.code, platform: claims.platform, ip });
  logEvent('info', 'embed.session', { server: server.code, platform: claims.platform, renewal });
  return { embedToken };
}

const tooMany = (retryAfterSec: number) => problemResponse(429, 'rate_limited', { 'Retry-After': String(retryAfterSec) });

/**
 * POST /api/embed/session. Запрос только JSON со страницы портала (страница виджета работает на адресе портала).
 * Пределы: 120 в минуту с адреса до проверки подписи, 30 в минуту на пользователя, после 20 неудач за 10 минут
 * адрес закрыт до конца окна (решение 14). Любой отказ проверки токена: 401 invalid_context без причины.
 */
export async function handleEmbedSession(request: Request): Promise<Response> {
  const cfg = embedConfig();
  if (!isSameOriginJson(request, getEnv().HUB_URL)) return problemResponse(403, 'forbidden');
  if (!cfg) return problemResponse(503, 'embed_disabled');
  const ip = clientIp(request.headers);
  const bucket = ipBucket(ip);
  const perIp = await consumeRateLimit(rateKey('embed-session:ip', bucket), RATE_RULES.embedSessionPerIp);
  if (!perIp.allowed) return tooMany(perIp.retryAfterSec);
  const failKey = rateKey('embed-session:fail', bucket);
  const failures = await peekRateLimit(failKey, RATE_RULES.embedSessionFailuresPerIp);
  if (!failures.allowed) return tooMany(failures.retryAfterSec);

  const text = await readLimited(request, MAX_BODY_BYTES);
  if (text === null) return problemResponse(413, 'too_large');
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return problemResponse(400, 'invalid_input');
  }
  const parsed = sessionInput.safeParse(body);
  if (!parsed.success) return problemResponse(400, 'invalid_input');

  try {
    const result = await exchange(parsed.data.contextToken, cfg, await bearerClaims(request, cfg), ip);
    if ('embedToken' in result) return Response.json({ embedToken: result.embedToken, expiresIn: EMBED_TOKEN_TTL_SEC }, { headers: NO_STORE });
    if (result.denied === 'rate_limited') return tooMany(result.retryAfterSec);
    return problemResponse(403, 'forbidden');
  } catch (error) {
    if (!(error instanceof ContextRejected)) throw error;
    await consumeRateLimit(failKey, RATE_RULES.embedSessionFailuresPerIp);
    // Причина только в журнал работы: ответ одинаков для любой причины.
    logEvent('warn', 'embed.context_rejected', { reason: error.reason });
    return problemResponse(401, 'invalid_context');
  }
}
