import 'server-only';
import * as z from 'zod';
import type { StaffActor, SystemActor } from '@/db/with-actor';
import { getEnv } from '@/env';
import { readActiveServers, readServers, saveServer, type ServerRow, setServerState } from '../core/servers';
import { HduError } from '../error';
import { parseInput } from '../input';
import { CLIENT_ROLES, SERVER_CODE_PATTERN } from '../pref';
import { assertPublicUrl, isLocalPortal } from '../url-safety';

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

function assertCanManageServers(actor: SystemActor | StaffActor): void {
  const allowed = actor.type === 'system' || (actor.type === 'staff' && actor.staffRole === 'admin');
  if (!allowed) throw new HduError('forbidden');
}

/**
 * Добавляет сервер Smartup или обновляет сервер с тем же кодом. Все адреса проверяются:
 * только внешние узлы по https (угроза T16). Секрет клиента хранится зашифрованным.
 */
export async function addServer(actor: SystemActor | StaffActor, input: unknown, ip: string | null = null): Promise<{ code: string }> {
  assertCanManageServers(actor);
  const data = parseInput(serverInput, input);
  const allowLoopback = isLocalPortal(getEnv().HUB_URL);
  const baseUrl = await assertPublicUrl(data.baseUrl, { allowLoopback });
  // Адрес Smartup Web хранится без пути: по его узлу клиент выделенного сервера находит свой вход.
  if (baseUrl.pathname !== '/' || baseUrl.search || baseUrl.hash) throw new HduError('invalid_input');
  await assertPublicUrl(data.issuer, { allowLoopback });
  if (data.endpoints) for (const url of Object.values(data.endpoints)) await assertPublicUrl(url, { allowLoopback });
  await saveServer(actor, { ...data, baseUrl: baseUrl.origin }, ip);
  return { code: data.code };
}

/** Отключает сервер: начать вход через него нельзя. */
export async function disableServer(actor: SystemActor | StaffActor, code: unknown, ip: string | null = null): Promise<void> {
  assertCanManageServers(actor);
  if (!(await setServerState(actor, parseInput(codeInput, code), 'passive', ip))) throw new HduError('not_found');
}

/** Список серверов для администратора и команды консоли: без секрета и идентификатора клиента. */
export async function listServers(actor: SystemActor | StaffActor): Promise<ServerView[]> {
  assertCanManageServers(actor);
  return readServers(actor);
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
