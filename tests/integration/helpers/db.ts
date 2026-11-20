import { Pool, type PoolClient } from 'pg';
import type { Actor, ClientActor, StaffActor, SystemActor } from '@/db/with-actor';

// Адреса задаёт tests/integration/setup/global-setup.ts.
const need = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`Интеграционные тесты: не задана переменная ${name}`);
  return value;
};

export const appUrl = need('DATABASE_URL_APP');

/** Прямые подключения под каждой ролью, в обход withActor. */
// Суперпользователь в базе портала: читает и пишет в обход RLS. Только для подготовки данных и проверок.
const rootUrl = new URL(need('DATABASE_URL_SUPERUSER'));
rootUrl.pathname = `/${process.env.HUB_DB_NAME ?? 'hub'}`;

export const pools = {
  owner: new Pool({ connectionString: need('DATABASE_URL_OWNER'), max: 2 }),
  app: new Pool({ connectionString: appUrl, max: 2 }),
  auth: new Pool({ connectionString: need('DATABASE_URL_AUTH'), max: 2 }),
  root: new Pool({ connectionString: rootUrl.toString(), max: 2 }),
};

/**
 * Транзакция с переменными актора, как их ставят withActor и withIdentity.
 * Запросы идут напрямую в базу: так проверяется сама политика, а не сервис поверх неё.
 */
export async function asActor<T>(pool: Pool, actor: Actor, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query(
      `select set_config('app.actor_type', $1, true), set_config('app.user_id', $2, true),
              set_config('app.org_id', $3, true), set_config('app.org_role', $4, true),
              set_config('app.staff_role', $5, true)`,
      [
        actor.type,
        'userId' in actor ? actor.userId : '',
        actor.type === 'client' ? actor.orgId : '',
        actor.type === 'client' ? actor.orgRole : '',
        actor.type === 'staff' ? actor.staffRole : '',
      ],
    );
    const result = await fn(client);
    await client.query('commit');
    return result;
  } catch (error) {
    await client.query('rollback').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Удаляет всё, что создали миграции: журнал, схемы app и auth, таблицы и представления схемы public.
 * После этого migrate() применяет все файлы заново.
 */
export async function dropMigratedObjects(): Promise<void> {
  await pools.owner.query('delete from migrations.applied');
  const objects = await pools.owner.query(
    `select c.relkind, c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relkind in ('r', 'p', 'v') order by c.relkind desc`,
  );
  for (const { relkind, relname } of objects.rows)
    await pools.owner.query(`drop ${relkind === 'v' ? 'view' : 'table'} if exists public."${relname}" cascade`);
  await pools.owner.query('drop schema if exists auth cascade');
  await pools.owner.query('drop schema if exists app cascade');
}

/** Сравнение версий вида 0.8.7: отрицательное число, если a меньше b. */
export function compareVersions(a: string, b: string): number {
  const left = a.split('.').map(Number);
  const right = b.split('.').map(Number);
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const diff = (left[i] ?? 0) - (right[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

export const admin: StaffActor = { type: 'staff', userId: 'staff-admin-1', staffRole: 'admin' };
export const agentL1: StaffActor = { type: 'staff', userId: 'staff-l1-1', staffRole: 'agent_l1' };
export const clientA: ClientActor = {
  type: 'client',
  userId: 'client-a-1',
  orgId: '019a1111-1111-7111-8111-111111111111',
  orgRole: 'client_user',
};
export const system: SystemActor = { type: 'system', job: 'integration-test' };
