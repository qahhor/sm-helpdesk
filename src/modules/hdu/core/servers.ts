import 'server-only';
import { asc, eq, sql } from 'drizzle-orm';
import { withIdentity } from '@/db/with-identity';
import { getSecretBox } from '@/security/secret-box';
import type { SsoServer } from '../auth/sso-providers';
import { servers } from '../schema';

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
