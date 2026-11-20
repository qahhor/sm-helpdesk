import 'server-only';
import * as z from 'zod';
import type { StaffActor, SystemActor } from '@/db/with-actor';
import { getEnv } from '@/env';
import {
  readActiveServers,
  readServer,
  readServerForCheck,
  readServers,
  saveServer,
  saveServerCheck,
  type ServerCheckResult,
  type ServerDetails,
  type ServerRow,
  setServerState,
  updateServerRow,
} from '../core/servers';
import { HduError } from '../error';
import { parseInput } from '../input';
import { CLIENT_ROLES, SERVER_CODE_PATTERN, type ServerIssue } from '../pref';
import { assertPublicUrl, isLocalPortal, SafeFetchError, safeFetchJson } from '../url-safety';
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
export type { ServerDetails, ServerIssue };
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

// --- Проверка связи (FR-ADM-01) ---

const CHECK_LIMITS = { timeoutMs: 5000, maxBytes: 64 * 1024 };

const nonEmpty = (value: unknown) => typeof value === 'string' && value.trim() !== '';

/** Причина неудачной загрузки как проблема проверки. Внутренний адрес выглядит как недоступный сервер. */
function fetchIssue(error: unknown): ServerIssue {
  if (error instanceof SafeFetchError) return error.reason === 'timeout' ? 'timeout' : error.reason === 'not_json' ? 'not_json' : 'unreachable';
  if (error instanceof HduError) return 'unreachable';
  throw error;
}

/** Что не так с документом discovery: issuer, адреса и поддержка PKCE S256. */
function discoveryIssues(doc: unknown, issuer: string): ServerIssue[] {
  if (typeof doc !== 'object' || doc === null || Array.isArray(doc)) return ['not_json'];
  const d = doc as Record<string, unknown>;
  const issues: ServerIssue[] = [];
  if (d.issuer !== issuer) issues.push('issuer_mismatch');
  if (!nonEmpty(d.authorization_endpoint)) issues.push('no_authorization_endpoint');
  if (!nonEmpty(d.token_endpoint)) issues.push('no_token_endpoint');
  if (!nonEmpty(d.userinfo_endpoint)) issues.push('no_userinfo_endpoint');
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
