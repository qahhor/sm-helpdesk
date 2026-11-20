import 'server-only';
import { and, asc, eq, ne, sql } from 'drizzle-orm';
import type { Actor } from '@/db/with-actor';
import { withIdentity } from '@/db/with-identity';
import { writeAudit } from '@/modules/hdc/audit';
import { getSecretBox } from '@/security/secret-box';
import type { SsoServer } from '../auth/sso-providers';
import type { ClientRole, RecordState } from '../pref';
import { type OidcEndpoints, servers } from '../schema';

// Модуль hdu, слой core: реестр серверов Smartup. Операции с данными под ролью hub_auth.

const SYSTEM = { type: 'system', job: 'identity.servers' } as const;

/** Место хранения секрета: входит в проверку подлинности зашифрованной строки. */
export const secretContext = (code: string) => `hdu_servers:${code}`;

/** Действующие серверы с расшифрованным секретом. Только для библиотеки входа: наружу не отдаётся. */
export async function listSsoServers(): Promise<SsoServer[]> {
  const rows = await withIdentity(SYSTEM, (tx) =>
    tx
      .select({
        code: servers.code,
        issuer: servers.issuer,
        clientId: servers.oauthClientId,
        sealed: servers.oauthClientSecret,
        endpoints: servers.oidcEndpoints,
      })
      .from(servers)
      .where(eq(servers.state, 'active'))
      .orderBy(asc(servers.code)),
  );
  const box = getSecretBox();
  return rows.map(({ sealed, ...server }) => ({ ...server, clientSecret: box.open(sealed, secretContext(server.code)) }));
}

/** Отметка состояния реестра: меняется при добавлении, изменении и отключении сервера. */
export async function registryStamp(): Promise<string> {
  const rows = await withIdentity(SYSTEM, (tx) =>
    tx
      .select({
        total: sql<number>`count(*)::int`,
        latest: sql<string | null>`max(${servers.modifiedOn})::text`,
      })
      .from(servers),
  );
  return `${rows[0]?.total ?? 0}:${rows[0]?.latest ?? ''}`;
}

export type ServerInput = {
  code: string;
  name: string;
  baseUrl: string;
  issuer: string;
  clientId: string;
  clientSecret: string;
  isDefault: boolean;
  roleMap?: Record<string, ClientRole>;
  endpoints?: OidcEndpoints;
};

/**
 * Добавляет сервер или обновляет сервер с тем же кодом (код не меняется, состояние тоже).
 * Признак "по умолчанию" снимается с прежнего сервера в той же транзакции.
 */
export async function saveServer(actor: Actor, input: ServerInput, ip: string | null = null): Promise<void> {
  const sealed = getSecretBox().seal(input.clientSecret, secretContext(input.code));
  await withIdentity(actor, async (tx) => {
    if (input.isDefault)
      await tx.update(servers).set({ isDefault: false }).where(and(eq(servers.isDefault, true), ne(servers.code, input.code)));
    const values = {
      name: input.name,
      baseUrl: input.baseUrl,
      issuer: input.issuer,
      oauthClientId: input.clientId,
      oauthClientSecret: sealed,
      oidcEndpoints: input.endpoints ?? null,
      roleMap: input.roleMap ?? {},
      isDefault: input.isDefault,
    };
    const existing = await tx.select({ code: servers.code }).from(servers).where(eq(servers.code, input.code)).limit(1);
    if (existing.length > 0) await tx.update(servers).set(values).where(eq(servers.code, input.code));
    else await tx.insert(servers).values({ ...values, code: input.code });
    await writeAudit(tx, {
      action: 'server.added',
      objectType: 'server',
      objectId: input.code,
      diff: { isDefault: input.isDefault, updated: existing.length > 0 },
      ip,
    });
  });
}

/** Отключает сервер: вход через него закрывается. Возвращает false, если сервера с таким кодом нет. */
export async function setServerState(actor: Actor, code: string, state: RecordState, ip: string | null = null): Promise<boolean> {
  return withIdentity(actor, async (tx) => {
    const updated = await tx.update(servers).set({ state }).where(eq(servers.code, code)).returning({ code: servers.code });
    if (updated.length === 0) return false;
    await writeAudit(tx, {
      action: state === 'passive' ? 'server.disabled' : 'server.enabled',
      objectType: 'server',
      objectId: code,
      ip,
    });
    return true;
  });
}

export type ServerRow = { code: string; name: string; baseUrl: string; isDefault: boolean; state: RecordState };

/** Список серверов без секрета и идентификатора клиента. */
export async function readServers(actor: Actor): Promise<ServerRow[]> {
  return withIdentity(actor, (tx) =>
    tx
      .select({ code: servers.code, name: servers.name, baseUrl: servers.baseUrl, isDefault: servers.isDefault, state: servers.state })
      .from(servers)
      .orderBy(asc(servers.code)),
  );
}

/** Действующие серверы для страницы входа: код, название, адрес Smartup. Без секретов. */
export async function readActiveServers(): Promise<{ code: string; name: string; baseUrl: string; isDefault: boolean }[]> {
  return withIdentity(SYSTEM, (tx) =>
    tx
      .select({ code: servers.code, name: servers.name, baseUrl: servers.baseUrl, isDefault: servers.isDefault })
      .from(servers)
      .where(eq(servers.state, 'active')),
  );
}
