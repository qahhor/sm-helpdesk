import 'server-only';
import { and, asc, eq, ne, sql } from 'drizzle-orm';
import type { Actor } from '@/db/with-actor';
import { withIdentity } from '@/db/with-identity';
import { writeAudit } from '@/modules/hdc/audit';
import { getSecretBox } from '@/security/secret-box';
import { HduError } from '../error';
import type { SsoServer } from '../auth/sso-providers';
import type { ClientRole, RecordState, ServerIssue } from '../pref';
import { type OidcEndpoints, serverChecks, servers } from '../schema';

// Модуль hdu, слой core: реестр серверов Smartup. Операции с данными под ролью hub_auth.

const SYSTEM = { type: 'system', job: 'identity.servers' } as const;

const UNIQUE_VIOLATION = '23505';

/** Адрес Smartup или сервера входа уже у другого сервера: уникальность в базе (hdu_servers_u2, u3). */
async function uniqueAddresses<T>(work: Promise<T>): Promise<T> {
  try {
    return await work;
  } catch (error) {
    if ((error as { code?: string }).code === UNIQUE_VIOLATION) throw new HduError('server_taken');
    throw error;
  }
}

/** Место хранения секрета: входит в проверку подлинности зашифрованной строки. */
export const secretContext = (code: string) => `hdu_servers:${code}`;

/**
 * Действующие серверы с расшифрованным секретом. Только для библиотеки входа: наружу не отдаётся.
 * Сервер, секрет которого не расшифровывается (сменили ключ, строку повредили), пропускается с записью
 * в журнал: иначе один испорченный секрет остановил бы любой вход в портал, в том числе сотрудников.
 */
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
  const ready: SsoServer[] = [];
  for (const { sealed, ...server } of rows) {
    try {
      ready.push({ ...server, clientSecret: box.open(sealed, secretContext(server.code)) });
    } catch {
      console.error(`Сервер Smartup ${server.code} пропущен: секрет не расшифровывается. Задайте секрет заново командой hub server:add`);
    }
  }
  return ready;
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
export async function saveServer(
  actor: Actor,
  input: ServerInput,
  ip: string | null = null,
  opts: { createOnly?: boolean } = {},
): Promise<void> {
  const sealed = getSecretBox().seal(input.clientSecret, secretContext(input.code));
  const work = withIdentity(actor, async (tx) => {
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
    // Форма "Добавить сервер" существующий сервер не перезаписывает: его меняют на карточке.
    if (existing.length > 0 && opts.createOnly) throw new HduError('server_taken');
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
  await uniqueAddresses(work);
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

export type ServerCheckResult = { ok: boolean; issues: ServerIssue[]; checkedOn: Date };

export type ServerRow = {
  code: string;
  name: string;
  baseUrl: string;
  isDefault: boolean;
  state: RecordState;
  /** Результат последней проверки связи. Пусто, если сервер ещё не проверяли. */
  lastCheck: ServerCheckResult | null;
};

const rowColumns = {
  code: servers.code,
  name: servers.name,
  baseUrl: servers.baseUrl,
  isDefault: servers.isDefault,
  state: servers.state,
  checkOk: serverChecks.isOk,
  checkIssues: serverChecks.issues,
  checkedOn: serverChecks.checkedOn,
};

type RawRow = Omit<ServerRow, 'lastCheck'> & { checkOk: boolean | null; checkIssues: ServerIssue[] | null; checkedOn: Date | null };

const toRow = ({ checkOk, checkIssues, checkedOn, ...row }: RawRow): ServerRow => ({
  ...row,
  lastCheck: checkOk === null || checkedOn === null ? null : { ok: checkOk, issues: checkIssues ?? [], checkedOn },
});

/** Список серверов без секрета и идентификатора клиента, с результатом последней проверки. */
export async function readServers(actor: Actor): Promise<ServerRow[]> {
  const rows = await withIdentity(actor, (tx) =>
    tx.select(rowColumns).from(servers).leftJoin(serverChecks, eq(serverChecks.serverId, servers.serverId)).orderBy(asc(servers.code)),
  );
  return rows.map(toRow);
}

export type ServerDetails = ServerRow & {
  issuer: string;
  clientId: string;
  roleMap: Record<string, ClientRole>;
  endpoints: OidcEndpoints | null;
};

/** Один сервер для карточки администратора: всё, кроме секрета. */
export async function readServer(actor: Actor, code: string): Promise<ServerDetails | null> {
  const columns = { ...rowColumns, issuer: servers.issuer, clientId: servers.oauthClientId, roleMap: servers.roleMap, endpoints: servers.oidcEndpoints };
  const rows = await withIdentity(actor, (tx) =>
    tx.select(columns).from(servers).leftJoin(serverChecks, eq(serverChecks.serverId, servers.serverId)).where(eq(servers.code, code)).limit(1),
  );
  const row = rows[0];
  if (!row) return null;
  const { issuer, clientId, roleMap, endpoints, ...rest } = row;
  return { ...toRow(rest), issuer, clientId, roleMap, endpoints };
}

export type ServerPatch = Partial<{
  name: string;
  baseUrl: string;
  issuer: string;
  clientId: string;
  /** Новый секрет. Не задан: прежний остаётся. */
  clientSecret: string;
  isDefault: boolean;
  roleMap: Record<string, ClientRole>;
  /** null: явные адреса снимаются, сервер работает по документу discovery. */
  endpoints: OidcEndpoints | null;
}>;

/** Запись в JSON с ключами по порядку: для сравнения соответствия ролей и адресов. */
const canonical = (value: unknown): string =>
  JSON.stringify(value, (_key, nested: unknown) =>
    nested && typeof nested === 'object' && !Array.isArray(nested)
      ? Object.fromEntries(Object.entries(nested as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)))
      : nested,
  );

const PATCH_FIELDS = ['name', 'baseUrl', 'issuer', 'clientId', 'isDefault', 'roleMap', 'endpoints'] as const;

/**
 * Меняет поля сервера. В журнал идут имена изменённых полей, без значений: среди них секрет.
 * Ничего не изменилось: ни записи, ни журнала. Возвращает false, если сервера с таким кодом нет.
 */
export async function updateServerRow(actor: Actor, code: string, patch: ServerPatch, ip: string | null = null): Promise<boolean> {
  const sealed = patch.clientSecret === undefined ? undefined : getSecretBox().seal(patch.clientSecret, secretContext(code));
  return uniqueAddresses(
    withIdentity(actor, async (tx) => {
      const found = await tx
        .select({
          name: servers.name,
          baseUrl: servers.baseUrl,
          issuer: servers.issuer,
          clientId: servers.oauthClientId,
          isDefault: servers.isDefault,
          roleMap: servers.roleMap,
          endpoints: servers.oidcEndpoints,
        })
        .from(servers)
        .where(eq(servers.code, code))
        .limit(1)
        .for('update');
      const current = found[0];
      if (!current) return false;
      const changed: string[] = PATCH_FIELDS.filter((key) => patch[key] !== undefined && canonical(patch[key]) !== canonical(current[key]));
      if (sealed !== undefined) changed.push('clientSecret');
      if (changed.length === 0) return true;
      if (patch.isDefault === true)
        await tx.update(servers).set({ isDefault: false }).where(and(eq(servers.isDefault, true), ne(servers.code, code)));
      await tx
        .update(servers)
        .set({
          ...(patch.name !== undefined && { name: patch.name }),
          ...(patch.baseUrl !== undefined && { baseUrl: patch.baseUrl }),
          ...(patch.issuer !== undefined && { issuer: patch.issuer }),
          ...(patch.clientId !== undefined && { oauthClientId: patch.clientId }),
          ...(sealed !== undefined && { oauthClientSecret: sealed }),
          ...(patch.isDefault !== undefined && { isDefault: patch.isDefault }),
          ...(patch.roleMap !== undefined && { roleMap: patch.roleMap }),
          ...(patch.endpoints !== undefined && { oidcEndpoints: patch.endpoints }),
        })
        .where(eq(servers.code, code));
      await writeAudit(tx, { action: 'server.updated', objectType: 'server', objectId: code, diff: { changed }, ip });
      return true;
    }),
  );
}

/** Что нужно проверке связи: идентификатор, адрес сервера входа и явные адреса. */
export async function readServerForCheck(
  actor: Actor,
  code: string,
): Promise<{ serverId: string; issuer: string; endpoints: OidcEndpoints | null } | null> {
  const rows = await withIdentity(actor, (tx) =>
    tx
      .select({ serverId: servers.serverId, issuer: servers.issuer, endpoints: servers.oidcEndpoints })
      .from(servers)
      .where(eq(servers.code, code))
      .limit(1),
  );
  return rows[0] ?? null;
}

/** Запоминает результат последней проверки. Реестр не меняется: вход не перестраивается. */
export async function saveServerCheck(actor: Actor, serverId: string, result: { ok: boolean; issues: ServerIssue[] }): Promise<Date> {
  return withIdentity(actor, async (tx) => {
    const values = { isOk: result.ok, issues: result.issues, checkedOn: sql`now()` };
    const [row] = await tx
      .insert(serverChecks)
      .values({ serverId, ...values })
      .onConflictDoUpdate({ target: serverChecks.serverId, set: values })
      .returning({ checkedOn: serverChecks.checkedOn });
    if (!row) throw new Error('Результат проверки не записан');
    return row.checkedOn;
  });
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
