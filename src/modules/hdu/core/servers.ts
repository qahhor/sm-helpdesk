import 'server-only';
import { randomBytes } from 'node:crypto';
import { and, asc, eq, isNotNull, ne, sql } from 'drizzle-orm';
import type { Actor } from '@/db/with-actor';
import { withIdentity } from '@/db/with-identity';
import { writeAudit } from '@/modules/hdc/api';
import { getSecretBox } from '@/security/secret-box';
import { HduError } from '../error';
import type { SsoServer } from '../auth/sso-providers';
import { CONTEXT_ALGORITHMS, type ClientRole, type ContextKeyMode, type RecordState, type ServerIssue } from '../pref';
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
/** Место хранения секрета токена контекста: строку секрета OAuth нельзя подставить вместо него и наоборот. */
export const contextSecretContext = (code: string) => `hdu_servers:${code}:context`;

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

/**
 * Перешифровывает секреты серверов текущим ключом (замена ключа, находка S6 аудита 23.11.2026). Идёт по всем
 * серверам, включая отключённые: отключённый сервер могут включить после того, как прежний ключ убран.
 * Секрет, который не открывается ни одним ключом, не трогается, его код возвращается в failed.
 */
export async function resealServerSecrets(actor: Actor): Promise<{ resealed: number; failed: string[] }> {
  const box = getSecretBox();
  return withIdentity(actor, async (tx) => {
    const rows = await tx
      .select({ code: servers.code, sealed: servers.oauthClientSecret, contextSealed: servers.contextSecret })
      .from(servers)
      .orderBy(asc(servers.code));
    let resealed = 0;
    const failed: string[] = [];
    // Под try только шифрование: ошибка базы не должна выглядеть как "секрет не открывается" (итоговая проверка W1, F9).
    const resealOne = (sealed: string, context: string): string | null | 'failed' => {
      try {
        return box.needsReseal(sealed, context) ? box.reseal(sealed, context) : null;
      } catch {
        return 'failed';
      }
    };
    for (const row of rows) {
      // Секрет клиента OAuth и секрет токена контекста (план M6, задача 1): оба шифруются ключом ENCRYPTION_KEY.
      const oauth = resealOne(row.sealed, secretContext(row.code));
      const context = row.contextSealed === null ? null : resealOne(row.contextSealed, contextSecretContext(row.code));
      if (oauth === 'failed' || context === 'failed') failed.push(row.code);
      const patch = {
        ...(oauth !== null && oauth !== 'failed' && { oauthClientSecret: oauth }),
        ...(context !== null && context !== 'failed' && { contextSecret: context }),
      };
      if (Object.keys(patch).length === 0) continue;
      await tx.update(servers).set(patch).where(eq(servers.code, row.code));
      resealed += 1;
    }
    // В журнал идут только числа: ни секрет, ни зашифрованная строка.
    if (resealed > 0 || failed.length > 0)
      await writeAudit(tx, { action: 'secrets.resealed', objectType: 'server', diff: { resealed, failed: failed.length } });
    return { resealed, failed };
  });
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
    // Издатель токена контекста нового сервера: адрес сервера входа (решение 4 плана M6), его можно сменить на карточке.
    else await tx.insert(servers).values({ ...values, code: input.code, contextIssuer: input.issuer });
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

/** Настройки виджета сервера для карточки администратора (план M6, задача 1). Секрета нет: только признак, что он задан. */
export type ServerWidget = {
  contextIssuer: string;
  contextKeyMode: ContextKeyMode | null;
  contextJwksUrl: string | null;
  hasContextSecret: boolean;
  embedKey: string;
  embedOrigins: string[];
};

export type ServerDetails = ServerRow & {
  issuer: string;
  clientId: string;
  roleMap: Record<string, ClientRole>;
  endpoints: OidcEndpoints | null;
  widget: ServerWidget;
};

/** Один сервер для карточки администратора: всё, кроме секретов. */
export async function readServer(actor: Actor, code: string): Promise<ServerDetails | null> {
  const columns = {
    ...rowColumns,
    issuer: servers.issuer,
    clientId: servers.oauthClientId,
    roleMap: servers.roleMap,
    endpoints: servers.oidcEndpoints,
    contextIssuer: servers.contextIssuer,
    contextKeyMode: servers.contextKeyMode,
    contextJwksUrl: servers.contextJwksUrl,
    hasContextSecret: sql<boolean>`${servers.contextSecret} is not null`,
    embedKey: servers.embedKey,
    embedOrigins: servers.embedOrigins,
  };
  const rows = await withIdentity(actor, (tx) =>
    tx.select(columns).from(servers).leftJoin(serverChecks, eq(serverChecks.serverId, servers.serverId)).where(eq(servers.code, code)).limit(1),
  );
  const row = rows[0];
  if (!row) return null;
  const { issuer, clientId, roleMap, endpoints, contextIssuer, contextKeyMode, contextJwksUrl, hasContextSecret, embedKey, embedOrigins, ...rest } = row;
  return {
    ...toRow(rest),
    issuer,
    clientId,
    roleMap,
    endpoints,
    widget: { contextIssuer, contextKeyMode, contextJwksUrl, hasContextSecret, embedKey, embedOrigins },
  };
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

// --- Виджет: токен контекста и встраивание (план M6, задачи 1-3; решения 2, 4 и 6) ---

export type WidgetPatch = {
  /** null: виджет с этим сервером выключен. */
  mode: ContextKeyMode | null;
  /** Не задан: прежний издатель остаётся. */
  contextIssuer?: string;
  /** Адрес ключей для режима jwks. null снимает адрес. Не задан: прежний остаётся. */
  jwksUrl?: string | null;
  embedOrigins: string[];
};

/** Новый общий секрет токена контекста: 32 случайных байта в base64url, для HS256 этого достаточно. */
function newContextSecret(): string {
  return randomBytes(32).toString('base64url');
}

const WIDGET_FIELDS = ['contextKeyMode', 'contextIssuer', 'contextJwksUrl', 'embedOrigins'] as const;

/**
 * Меняет настройки виджета сервера. Переход в режим secret без секрета создаёт секрет: его открытый текст
 * возвращается один раз, в базе он только зашифрован. В журнал идут имена изменённых полей, без значений.
 * Ничего не изменилось: ни записи, ни журнала. Сервера нет: not_found. Издатель занят другим сервером: server_taken.
 */
export async function updateWidgetRow(actor: Actor, code: string, patch: WidgetPatch, ip: string | null = null): Promise<{ secret: string | null } | null> {
  return uniqueAddresses(
    withIdentity(actor, async (tx) => {
      const found = await tx
        .select({
          contextKeyMode: servers.contextKeyMode,
          contextIssuer: servers.contextIssuer,
          contextJwksUrl: servers.contextJwksUrl,
          embedOrigins: servers.embedOrigins,
          hasSecret: sql<boolean>`${servers.contextSecret} is not null`,
        })
        .from(servers)
        .where(eq(servers.code, code))
        .limit(1)
        .for('update');
      const current = found[0];
      if (!current) return null;
      const next = {
        contextKeyMode: patch.mode,
        contextIssuer: patch.contextIssuer ?? current.contextIssuer,
        contextJwksUrl: patch.jwksUrl === undefined ? current.contextJwksUrl : patch.jwksUrl,
        embedOrigins: patch.embedOrigins,
      };
      if (next.contextKeyMode === 'jwks' && !next.contextJwksUrl) throw new HduError('invalid_input');
      const secret = next.contextKeyMode === 'secret' && !current.hasSecret ? newContextSecret() : null;
      const changed: string[] = WIDGET_FIELDS.filter((key) => canonical(next[key]) !== canonical(current[key]));
      if (secret !== null) changed.push('contextSecret');
      if (changed.length === 0) return { secret: null };
      await tx
        .update(servers)
        .set({ ...next, ...(secret !== null && { contextSecret: getSecretBox().seal(secret, contextSecretContext(code)) }) })
        .where(eq(servers.code, code));
      await writeAudit(tx, { action: 'server.widget_updated', objectType: 'server', objectId: code, diff: { changed }, ip });
      return { secret };
    }),
  );
}

/** Создаёт новый общий секрет токена контекста вместо прежнего. Открытый текст возвращается один раз. */
export async function rotateContextSecret(actor: Actor, code: string, ip: string | null = null): Promise<{ secret: string } | null> {
  const secret = newContextSecret();
  const sealed = getSecretBox().seal(secret, contextSecretContext(code));
  return withIdentity(actor, async (tx) => {
    const updated = await tx.update(servers).set({ contextSecret: sealed }).where(eq(servers.code, code)).returning({ code: servers.code });
    if (updated.length === 0) return null;
    // В журнале только факт замены: ни секрета, ни зашифрованной строки.
    await writeAudit(tx, { action: 'server.context_secret_created', objectType: 'server', objectId: code, ip });
    return { secret };
  });
}

/** Сервер для проверки токена контекста: действующий, с выбранным режимом. Секрет расшифрован и наружу не отдаётся. */
export type ContextServer = {
  serverId: string;
  code: string;
  contextIssuer: string;
  mode: ContextKeyMode;
  algorithms: readonly string[];
  jwksUrl: string | null;
  secret: string | null;
};

/**
 * Действующий сервер с настроенным виджетом по издателю токена контекста. Отключённый сервер, сервер без режима и
 * неизвестный издатель: null. Секрет, который не расшифровывается, тоже даёт null с записью в журнал работы.
 */
export async function readContextServer(contextIssuer: string): Promise<ContextServer | null> {
  const rows = await withIdentity(SYSTEM, (tx) =>
    tx
      .select({
        serverId: servers.serverId,
        code: servers.code,
        contextIssuer: servers.contextIssuer,
        mode: servers.contextKeyMode,
        jwksUrl: servers.contextJwksUrl,
        sealed: servers.contextSecret,
      })
      .from(servers)
      .where(and(eq(servers.contextIssuer, contextIssuer), eq(servers.state, 'active'), isNotNull(servers.contextKeyMode)))
      .limit(1),
  );
  const row = rows[0];
  if (!row?.mode) return null;
  let secret: string | null = null;
  if (row.mode === 'secret') {
    if (!row.sealed) return null;
    try {
      secret = getSecretBox().open(row.sealed, contextSecretContext(row.code));
    } catch {
      console.error(`Сервер Smartup ${row.code}: секрет токена контекста не расшифровывается. Создайте новый секрет на карточке сервера`);
      return null;
    }
  }
  return {
    serverId: row.serverId,
    code: row.code,
    contextIssuer: row.contextIssuer,
    mode: row.mode,
    algorithms: CONTEXT_ALGORITHMS[row.mode],
    jwksUrl: row.mode === 'jwks' ? row.jwksUrl : null,
    secret,
  };
}
