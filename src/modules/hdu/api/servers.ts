import 'server-only';
import * as z from 'zod';
import type { StaffActor, SystemActor } from '@/db/with-actor';
import { getEnv } from '@/env';
import {
  readActiveServers,
  readServer,
  readServerForCheck,
  readServers,
  resealServerSecrets as resealCore,
  rotateContextSecret,
  saveServer,
  saveServerCheck,
  type ServerCheckResult,
  type ServerDetails,
  type ServerRow,
  setServerState,
  type ServerWidget,
  updateServerRow,
  updateWidgetRow,
} from '../core/servers';
import { HduError } from '../error';
import { parseInput } from '../input';
import { CLIENT_ROLES, CONTEXT_KEY_MODES, EMBED_ORIGINS_MAX, SERVER_CODE_PATTERN, type ServerIssue } from '../pref';
import { assertPublicUrl, isLocalPortal, SafeFetchError, safeFetchJson } from '../url-safety';
import { LOOPBACK_HOSTS } from '@/security/outbound';
import { FRESH_SIGN_IN_SEC, isFresh, type StaffContext } from './session';

// Реестр серверов Smartup (FR-ID-02, FR-ADM-01). Этот файл не тянет библиотеку входа:
// его использует команда консоли hub.

const urlText = z.string().trim().min(1).max(500);

const serverInput = z.object({
  code: z.string().regex(SERVER_CODE_PATTERN),
  name: z.string().trim().min(1).max(120),
  baseUrl: urlText,
  issuer: urlText,
  clientId: z.string().trim().min(1).max(200),
  clientSecret: z.string().min(1).max(2000),
  isDefault: z.boolean().optional().default(false),
  roleMap: z.record(z.string().trim().min(1).max(100), z.enum(CLIENT_ROLES)).optional(),
  endpoints: z.object({ authorization: urlText, token: urlText, userinfo: urlText, jwks: urlText }).strict().optional(),
});

const codeInput = z.string().regex(SERVER_CODE_PATTERN);

export type ServerView = ServerRow;
export type { ServerDetails, ServerIssue, ServerWidget };
export type ServerCheck = ServerCheckResult;

function assertCanManageServers(actor: SystemActor | StaffActor): void {
  const allowed = actor.type === 'system' || (actor.type === 'staff' && actor.staffRole === 'admin');
  if (!allowed) throw new HduError('forbidden');
}

/**
 * Кто меняет реестр: команда консоли (актор system) или администратор портала со свежим входом
 * (15 минут, ТЗ 14.3). Сотрудник передаёт контекст сессии, а не голого актора: так свежесть входа
 * не обойти.
 */
export type ServerManager = SystemActor | StaffContext;

function managingActor(who: ServerManager, now: Date): SystemActor | StaffActor {
  if ('actor' in who) {
    assertCanManageServers(who.actor);
    if (!isFresh(who, now, FRESH_SIGN_IN_SEC)) throw new HduError('stale_session');
    return who.actor;
  }
  if (who.type !== 'system') throw new HduError('forbidden');
  return who;
}

/**
 * Замена ключа шифрования: секреты серверов перешифровываются текущим ключом. Только команда консоли.
 * Возвращает число перешифрованных и коды серверов, секрет которых не открылся ни одним ключом.
 */
export function resealServerSecrets(actor: SystemActor): Promise<{ resealed: number; failed: string[] }> {
  if (actor.type !== 'system') throw new HduError('forbidden');
  return resealCore(actor);
}

/** Адреса сервера по правилам реестра: внешние узлы по https, адрес Smartup Web без пути (угроза T16). */
async function checkedBaseUrl(raw: string, allowLoopback: boolean): Promise<string> {
  const baseUrl = await assertPublicUrl(raw, { allowLoopback });
  // Адрес Smartup Web хранится без пути: по его узлу клиент выделенного сервера находит свой вход.
  if (baseUrl.pathname !== '/' || baseUrl.search || baseUrl.hash) throw new HduError('invalid_input');
  return baseUrl.origin;
}

/**
 * Добавляет сервер Smartup. Команда консоли (актор system) обновляет сервер с тем же кодом;
 * администратор из рабочего места только создаёт новый: занятый код даёт server_taken, а сервер меняют
 * на его карточке (updateServer). Все адреса проверяются: только внешние узлы по https (угроза T16).
 * Секрет клиента хранится зашифрованным.
 */
export async function addServer(who: ServerManager, input: unknown, ip: string | null = null): Promise<{ code: string }> {
  const actor = managingActor(who, new Date());
  const data = parseInput(serverInput, input);
  const allowLoopback = isLocalPortal(getEnv().HUB_URL);
  const baseUrl = await checkedBaseUrl(data.baseUrl, allowLoopback);
  await assertPublicUrl(data.issuer, { allowLoopback });
  if (data.endpoints) for (const url of Object.values(data.endpoints)) await assertPublicUrl(url, { allowLoopback });
  await saveServer(actor, { ...data, baseUrl }, ip, { createOnly: 'actor' in who });
  return { code: data.code };
}

const updateInput = z
  .object({
    code: codeInput,
    name: serverInput.shape.name.optional(),
    baseUrl: urlText.optional(),
    issuer: urlText.optional(),
    clientId: serverInput.shape.clientId.optional(),
    // Пустой секрет из формы: не менять.
    clientSecret: z.string().max(2000).optional(),
    isDefault: z.boolean().optional(),
    roleMap: serverInput.shape.roleMap,
    endpoints: serverInput.shape.endpoints.unwrap().nullable().optional(),
  })
  .strict();

/** Меняет поля сервера. Код не меняется. Пустой или не заданный секрет: прежний остаётся. */
export async function updateServer(ctx: StaffContext, input: unknown, now: Date = new Date()): Promise<void> {
  const actor = managingActor(ctx, now);
  const { code, clientSecret, ...data } = parseInput(updateInput, input);
  const allowLoopback = isLocalPortal(getEnv().HUB_URL);
  const baseUrl = data.baseUrl === undefined ? undefined : await checkedBaseUrl(data.baseUrl, allowLoopback);
  if (data.issuer !== undefined) await assertPublicUrl(data.issuer, { allowLoopback });
  if (data.endpoints) for (const url of Object.values(data.endpoints)) await assertPublicUrl(url, { allowLoopback });
  const patch = { ...data, baseUrl, clientSecret: clientSecret ? clientSecret : undefined };
  if (!(await updateServerRow(actor, code, patch))) throw new HduError('not_found');
}

/** Отключает сервер: начать вход через него нельзя. */
export async function disableServer(who: ServerManager, code: unknown, ip: string | null = null): Promise<void> {
  const actor = managingActor(who, new Date());
  if (!(await setServerState(actor, parseInput(codeInput, code), 'passive', ip))) throw new HduError('not_found');
}

/** Включает отключённый сервер снова. */
export async function enableServer(ctx: StaffContext, code: unknown, now: Date = new Date()): Promise<void> {
  const actor = managingActor(ctx, now);
  if (!(await setServerState(actor, parseInput(codeInput, code), 'active'))) throw new HduError('not_found');
}

/** Список серверов для администратора и команды консоли: без секрета и идентификатора клиента. */
export async function listServers(actor: SystemActor | StaffActor): Promise<ServerView[]> {
  assertCanManageServers(actor);
  return readServers(actor);
}

/** Карточка сервера для администратора: всё, кроме секрета. Неверный или неизвестный код: пусто. */
export async function getServer(actor: SystemActor | StaffActor, code: unknown): Promise<ServerDetails | null> {
  assertCanManageServers(actor);
  const parsed = codeInput.safeParse(code);
  return parsed.success ? readServer(actor, parsed.data) : null;
}

/** Адрес возврата портала на сервере Smartup: его передают разработчикам Smartup при регистрации портала. */
export function serverCallbackUrl(code: string): string {
  return new URL(`/api/auth/sso/callback/${code}`, getEnv().HUB_URL).toString();
}

// --- Виджет: токен контекста и встраивание (план M6, задача 1; решения 2, 4 и 6) ---

const widgetInput = z
  .object({
    code: codeInput,
    // Пустое значение формы: виджет с сервером выключен.
    mode: z.enum(CONTEXT_KEY_MODES).nullable(),
    contextIssuer: urlText.optional(),
    jwksUrl: urlText.nullable().optional(),
    embedOrigins: z.array(z.string().trim().min(1).max(200)).max(EMBED_ORIGINS_MAX * 2),
  })
  .strict();

/**
 * Издатель токена контекста: адрес со схемой https (http только у локального портала и только для localhost),
 * без учётной записи, параметров и якоря. Портал по нему никуда не ходит: это строка для сравнения с iss.
 */
function checkedIssuer(raw: string, allowLoopback: boolean): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new HduError('invalid_input');
  }
  const loopbackHttp = allowLoopback && url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname);
  if ((url.protocol !== 'https:' && !loopbackHttp) || url.username || url.password || url.search || url.hash) throw new HduError('invalid_input');
  // Сравнивается с iss буква в букву: сохраняется то, что ввёл администратор, без нормализации URL.
  return raw;
}

/**
 * Адрес встраивания: ровно схема, узел и порт. https; http только у локального портала и только для localhost и
 * 127.0.0.1 (решение 0015). Значение попадает в заголовок frame-ancestors, поэтому сверяется с разобранным началом адреса.
 */
function checkedOrigin(raw: string, allowLoopback: boolean): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new HduError('invalid_input');
  }
  const loopbackHttp = allowLoopback && url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname);
  if ((url.protocol !== 'https:' && !loopbackHttp) || url.origin !== raw) throw new HduError('invalid_input');
  return url.origin;
}

/**
 * Настройки виджета сервера: режим подписи токена контекста, издатель, адрес ключей и адреса встраивания.
 * Только admin со свежим входом. Адрес ключей проверяется по правилам T16 (внешний узел, https). Переход в режим
 * secret без секрета создаёт секрет и возвращает его один раз: администратор передаёт его разработчикам Smartup.
 */
export async function updateWidgetSettings(ctx: StaffContext, input: unknown, now: Date = new Date()): Promise<{ secret: string | null }> {
  const actor = managingActor(ctx, now);
  const data = parseInput(widgetInput, input);
  const allowLoopback = isLocalPortal(getEnv().HUB_URL);
  const contextIssuer = data.contextIssuer === undefined ? undefined : checkedIssuer(data.contextIssuer, allowLoopback);
  const jwksUrl = data.jwksUrl ? (await assertPublicUrl(data.jwksUrl, { allowLoopback })).toString() : data.jwksUrl;
  const embedOrigins = [...new Set(data.embedOrigins.map((origin) => checkedOrigin(origin, allowLoopback)))];
  if (embedOrigins.length > EMBED_ORIGINS_MAX) throw new HduError('invalid_input');
  const result = await updateWidgetRow(actor, data.code, { mode: data.mode, contextIssuer, jwksUrl, embedOrigins });
  if (!result) throw new HduError('not_found');
  return result;
}

/** Новый общий секрет токена контекста вместо прежнего. Только admin со свежим входом. Секрет показывается один раз. */
export async function createContextSecret(ctx: StaffContext, code: unknown, now: Date = new Date()): Promise<{ secret: string }> {
  const actor = managingActor(ctx, now);
  const result = await rotateContextSecret(actor, parseInput(codeInput, code));
  if (!result) throw new HduError('not_found');
  return result;
}

/**
 * Фрагмент подключения виджета для разработчиков Smartup (ТЗ 11.9): загрузчик с адреса портала и вызов init с ключом
 * встраивания сервера. Имена currentLocale и requestContextToken обозначают код Smartup Web.
 */
export function widgetSnippet(embedKey: string): string {
  const hub = getEnv().HUB_URL;
  return [
    `<script src="${hub}/widget/v1/hub-widget.js" async></script>`,
    '',
    'window.SmartupHub.init({',
    `  hubUrl: '${hub}',`,
    `  embedKey: '${embedKey}',`,
    '  locale: currentLocale(),',
    '  getContextToken: () => requestContextToken(),',
    '});',
  ].join('\n');
}

// --- Проверка связи (FR-ADM-01) ---

const CHECK_LIMITS = { timeoutMs: 5000, maxBytes: 64 * 1024 };

const nonEmpty = (value: unknown) => typeof value === 'string' && value.trim() !== '';

/** Причина неудачной загрузки как проблема проверки. Внутренний адрес выглядит как недоступный сервер. */
function fetchIssue(error: unknown): ServerIssue {
  if (error instanceof SafeFetchError) return error.reason === 'timeout' ? 'timeout' : error.reason === 'not_json' ? 'not_json' : 'unreachable';
  if (error instanceof HduError) return 'unreachable';
  throw error;
}

/** Что не так с документом discovery: issuer, адреса входа, ключей и поддержка PKCE S256. */
function discoveryIssues(doc: unknown, issuer: string): ServerIssue[] {
  if (typeof doc !== 'object' || doc === null || Array.isArray(doc)) return ['not_json'];
  const d = doc as Record<string, unknown>;
  const issues: ServerIssue[] = [];
  if (d.issuer !== issuer) issues.push('issuer_mismatch');
  if (!nonEmpty(d.authorization_endpoint)) issues.push('no_authorization_endpoint');
  if (!nonEmpty(d.token_endpoint)) issues.push('no_token_endpoint');
  // Адрес сведений о пользователе не обязателен: портал берёт сведения из подписанного id_token (проверка main, Q21).
  if (!nonEmpty(d.jwks_uri)) issues.push('no_jwks');
  const methods = d.code_challenge_methods_supported;
  if (!Array.isArray(methods) || !methods.includes('S256')) issues.push('no_pkce_s256');
  return issues;
}

/**
 * Проверка связи с сервером Smartup. С документом discovery: загружает его и сверяет issuer, адреса
 * и S256. С явными адресами: отвечает ли адрес ключей. Результат запоминается для списка серверов;
 * в журнал аудита проверка не пишется: она ничего не меняет.
 */
export async function checkServer(actor: SystemActor | StaffActor, code: unknown): Promise<ServerCheck> {
  assertCanManageServers(actor);
  const server = await readServerForCheck(actor, parseInput(codeInput, code));
  if (!server) throw new HduError('not_found');
  const fetchOpts = { ...CHECK_LIMITS, allowLoopback: isLocalPortal(getEnv().HUB_URL) };
  let issues: ServerIssue[];
  try {
    if (server.endpoints) {
      const jwks = await safeFetchJson(new URL(server.endpoints.jwks), fetchOpts);
      const keys = typeof jwks === 'object' && jwks !== null ? (jwks as { keys?: unknown }).keys : undefined;
      issues = Array.isArray(keys) && keys.length > 0 ? [] : ['no_jwks'];
    } else {
      const url = new URL(`${server.issuer.replace(/\/+$/, '')}/.well-known/openid-configuration`);
      issues = discoveryIssues(await safeFetchJson(url, fetchOpts), server.issuer);
    }
  } catch (error) {
    issues = [fetchIssue(error)];
  }
  const ok = issues.length === 0;
  const checkedOn = await saveServerCheck(actor, server.serverId, { ok, issues });
  return { ok, issues, checkedOn };
}

/**
 * Сервер для входа клиента. Код задан (выбор, запомненный в браузере): действующий сервер с этим кодом
 * или ничего. На сервер по умолчанию вход сам не переключается: клиент выделенного сервера попал бы не туда.
 * Код не задан: действующий сервер по умолчанию.
 */
export async function findLoginServer(input: { code?: string | null }): Promise<{ code: string; name: string; host: string } | null> {
  const active = await readActiveServers();
  const code = input.code ?? null;
  if (code !== null && !SERVER_CODE_PATTERN.test(code)) return null;
  const found = code === null ? active.find((s) => s.isDefault) : active.find((s) => s.code === code);
  return found ? { code: found.code, name: found.name, host: new URL(found.baseUrl).host } : null;
}

/** Адрес, который ввёл клиент выделенного сервера, в любом написании: со схемой и без, с путём. */
function typedHost(address: unknown): string | null {
  if (typeof address !== 'string') return null;
  const text = address.trim();
  if (text.length === 0 || text.length > 500) return null;
  let url: URL;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  return url.host.toLowerCase();
}

/** Сервер по адресу Smartup, который ввёл клиент (FR-ID-03). Список серверов наружу не отдаётся. */
export async function findServerByAddress(address: unknown): Promise<{ code: string } | null> {
  const host = typedHost(address);
  if (!host) return null;
  const found = (await readActiveServers()).find((s) => new URL(s.baseUrl).host === host);
  return found ? { code: found.code } : null;
}
