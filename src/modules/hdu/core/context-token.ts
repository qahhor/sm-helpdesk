import { decodeJwt, decodeProtectedHeader, type JWSAlgorithm, jwtVerify } from 'jose';
import * as z from 'zod';
import { CONTEXT_AUDIENCE, CONTEXT_CLOCK_TOLERANCE_SEC, CONTEXT_MAX_TTL_SEC, CONTEXT_PLATFORMS, type ContextPlatform, SMARTUP_CLAIMS } from '../pref';
import type { ContextKeySource } from './context-keys';
import type { ContextServer } from './servers';

// Проверка токена контекста виджета (ТЗ 11.4; план M6, решение 4). Без базы: сервер из реестра и ключи приходят
// параметрами. Каждый отказ бросает ContextRejected с причиной для журнала работы; клиенту причина не уходит.

export type ContextRejectReason =
  | 'malformed'
  | 'unknown_issuer'
  | 'algorithm'
  | 'key_in_token'
  | 'signature'
  | 'claims'
  | 'lifetime'
  | 'replayed'
  | 'rate_limited'
  | 'keys_unavailable';

/**
 * Причины, которые говорят о подделке или мусоре от адреса запроса. Только они считаются неудачами адреса (решение 14
 * плана M6, замечание M1 проверки): повтор, срок, неполные сведения и недоступные ключи сервера Smartup адрес не
 * закрывают, иначе сбой на стороне Smartup или повторная отправка страницей закрывали бы адрес офиса клиента.
 */
export const ADDRESS_FAULTS: ReadonlySet<ContextRejectReason> = new Set(['malformed', 'unknown_issuer', 'algorithm', 'key_in_token', 'signature']);

export class ContextRejected extends Error {
  constructor(readonly reason: ContextRejectReason) {
    super(`Токен контекста отклонён: ${reason}`);
    this.name = 'ContextRejected';
  }
}

/** Ключей нет или документ не похож на JWKS: подпись проверить нечем (не вина того, кто прислал токен). */
export class ContextKeysUnavailableError extends Error {
  constructor() {
    super('Открытые ключи сервера Smartup не загружены');
    this.name = 'ContextKeysUnavailableError';
  }
}

/** Издатель из ещё не проверенного токена: только чтобы найти сервер в реестре. Ничему другому из него не верим. */
export function unverifiedIssuer(token: string): string {
  let iss: unknown;
  try {
    iss = decodeJwt(token).iss;
  } catch {
    throw new ContextRejected('malformed');
  }
  if (typeof iss !== 'string' || iss.length === 0 || iss.length > 500) throw new ContextRejected('malformed');
  return iss;
}

const id = (max: number) => z.preprocess((value) => (typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : value), z.string().trim().min(1).max(max));
const optional = (max: number) =>
  z
    .preprocess((value) => (value === null || value === '' ? undefined : value), z.string().trim().max(max).optional())
    .catch(undefined);

/** Поля токена контекста (ТЗ 11.4). Обязательные проверяются строго, необязательное с неверным значением отбрасывается. */
const contextClaims = z.object({
  sub: id(200),
  jti: z.string().min(1).max(200),
  iat: z.number().int(),
  exp: z.number().int(),
  company_id: id(200),
  company_name: z.string().trim().min(1).max(1000),
  name: z.string().trim().min(1).max(1000),
  platform: z.enum(CONTEXT_PLATFORMS),
  app_version: z.string().trim().min(1).max(32),
  email: optional(254),
  inn: optional(50),
  role: optional(100),
  locale: optional(35),
});

export type ContextClaims = {
  sub: string;
  jti: string;
  exp: number;
  platform: ContextPlatform;
  appVersion: string;
  /**
   * Сведения о человеке и компании в том же виде, что сведения OAuth после сопоставления полей (SMARTUP_CLAIMS):
   * их разбирает provisionFromSmartup. Ответ на вопрос 43 меняет одну таблицу для обоих путей.
   */
  profile: Record<string, string>;
};

// Заголовки, которые указывают ключ внутри токена или адрес ключей. Портал их не использует: ключ только из реестра.
// Токен с ними отклоняется сразу, чтобы проверка не зависела от того, как библиотека с ними обходится.
const KEY_HEADERS = ['jku', 'jwk', 'x5u', 'x5c'];

/**
 * Проверяет токен контекста сервера из реестра: подпись ключом сервера и алгоритмом его режима, издатель,
 * получатель smartup-hub, срок не больше 5 минут, iat не в будущем дальше 60 секунд, допуск часов 60 секунд,
 * обязательные поля. Одноразовость jti проверяет вызывающий (по таблице hdu_context_token_uses).
 */
export async function verifyContextToken(token: string, server: ContextServer, keys: ContextKeySource, now: Date = new Date()): Promise<ContextClaims> {
  let alg: unknown;
  let header: Record<string, unknown>;
  try {
    header = decodeProtectedHeader(token) as Record<string, unknown>;
    alg = header.alg;
  } catch {
    throw new ContextRejected('malformed');
  }
  // Подмена алгоритма: режим сервера задаёт список, alg none в него не входит никогда.
  if (typeof alg !== 'string' || !server.algorithms.includes(alg)) throw new ContextRejected('algorithm');
  if (KEY_HEADERS.some((name) => name in header)) throw new ContextRejected('key_in_token');

  let payload: unknown;
  try {
    const key = await keys.keyFor(server);
    const options = {
      algorithms: [...server.algorithms] as JWSAlgorithm[],
      issuer: server.contextIssuer,
      audience: CONTEXT_AUDIENCE,
      maxTokenAge: CONTEXT_MAX_TTL_SEC,
      clockTolerance: CONTEXT_CLOCK_TOLERANCE_SEC,
      requiredClaims: ['exp', 'iat', 'jti', 'sub'],
      currentDate: now,
    };
    payload = (key instanceof Uint8Array ? await jwtVerify(token, key, options) : await jwtVerify(token, key, options)).payload;
  } catch (error) {
    if (error instanceof ContextKeysUnavailableError) throw new ContextRejected('keys_unavailable');
    const { code, claim } = error as { code?: string; claim?: string };
    if (code === 'ERR_JWT_EXPIRED' || (code === 'ERR_JWT_CLAIM_VALIDATION_FAILED' && (claim === 'iat' || claim === 'nbf'))) throw new ContextRejected('lifetime');
    throw new ContextRejected(code === 'ERR_JWT_CLAIM_VALIDATION_FAILED' ? 'claims' : 'signature');
  }

  const parsed = contextClaims.safeParse(payload);
  if (!parsed.success) throw new ContextRejected('claims');
  const claims = parsed.data;
  const nowSec = Math.floor(now.getTime() / 1000);
  if (claims.exp - claims.iat > CONTEXT_MAX_TTL_SEC || claims.exp <= claims.iat || claims.iat > nowSec + CONTEXT_CLOCK_TOLERANCE_SEC)
    throw new ContextRejected('lifetime');

  const source: Record<string, unknown> = claims;
  const profile: Record<string, string> = { id: claims.sub, name: claims.name };
  for (const [ours, field] of Object.entries(SMARTUP_CLAIMS)) {
    const value = source[field];
    if (typeof value === 'string' && value !== '') profile[ours] = value;
  }
  return { sub: claims.sub, jti: claims.jti, exp: claims.exp, platform: claims.platform, appVersion: claims.app_version, profile };
}
