import { randomBytes } from 'node:crypto';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Pool } from 'pg';
import { PgBoss } from 'pg-boss';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { closeAuthPool } from '@/db/auth-client';
import { closeAppPool } from '@/db/client';
import { bossOptions } from '@/modules/hdc/jobs';
import { ideaPage } from '@/modules/hdi/api/board';
import { unvoteIdea, voteIdea } from '@/modules/hdi/api/votes';
import { getTicket, listQueue, listTickets } from '@/modules/hdt/api';
import { getSecretBox } from '@/security/secret-box';
import { bootstrap } from '../../scripts/db/bootstrap.mjs';
import { migrate } from '../../scripts/db/migrate.mjs';
import { clientCtx, staffCtx } from './helpers/auth';
import { pools } from './helpers/db';
import { seedEverything } from './isolation/seed-everything';
import { DOMAIN_OBJECTS } from './isolation/tables';

// Копия и восстановление на всех миграциях (план подготовки M9, задача 5; ТЗ 13.7; памятка docs/runbooks/restore.md).
// База портала со строками во всех таблицах снимается pg_dump -Fc под суперпользователем, как в backup.sh. Копия
// восстанавливается в чистый сервер PostgreSQL, подготовленный bootstrap по шагу 2 памятки, командой шага 4
// (pg_restore --clean --if-exists --exit-on-error), затем migrate по шагу 6. Сверяется всё, что держит изоляцию:
// число строк в каждой таблице, флаги RLS, политики, владельцы функций (функции счётчиков идей у hub_hdi_counter),
// права на таблицы, колонки, функции и схемы, членство ролей, расширения и последовательности. Потом портал работает
// на восстановленной базе: несколько вызовов слоя api под ролью hub_app, голос идеи через функцию счётчика, очередь задач.

const image = process.env.PG_IMAGE ?? 'pgvector/pgvector:pg18';
const SCHEMAS = ['public', 'auth', 'app', 'pgboss', 'migrations', 'ops'];
const SECRET_CONTEXT = 'hdn_channel_secrets:oncall_telegram_bot';

let target: StartedPostgreSqlContainer;
let targetSuper: Pool;
const passwords = { owner: randomBytes(18).toString('hex'), app: randomBytes(18).toString('hex'), auth: randomBytes(18).toString('hex') };
let targetUrl: (user: string, password: string) => string;

beforeAll(async () => {
  const superPassword = randomBytes(18).toString('hex');
  target = await new PostgreSqlContainer(image).withUsername('postgres').withPassword(superPassword).withDatabase('postgres').start();
  const address = `${target.getHost()}:${target.getMappedPort(5432)}`;
  targetUrl = (user, password) => `postgres://${user}:${password}@${address}/hub`;
  // Шаг 2 памятки: пустая база и роли (hubc run --rm bootstrap).
  await bootstrap({ superuserUrl: `postgres://postgres:${superPassword}@${address}/postgres`, dbName: 'hub', ownerPassword: passwords.owner, appPassword: passwords.app, authPassword: passwords.auth });
  targetSuper = new Pool({ connectionString: targetUrl('postgres', superPassword), max: 2 });
}, 180_000);

afterAll(async () => {
  await targetSuper?.end();
  await target?.stop();
});

/**
 * Снимок всего, что должно пережить копию: одинаковые запросы к исходной и восстановленной базе. Права сравниваются
 * действующие: пустой список прав это права по умолчанию (acldefault). pg_dump не пишет права, равные умолчанию, и
 * после восстановления у схемы ops вместо явного "только владелец" пустой список с тем же смыслом.
 */
async function snapshot(pool: Pool) {
  const q = async (text: string) => (await pool.query(text, text.includes('$1') ? [SCHEMAS] : [])).rows;
  const tables = await q(`select n.nspname || '.' || c.relname as name from pg_class c join pg_namespace n on n.oid = c.relnamespace
                           where c.relkind in ('r', 'p') and n.nspname = any($1) order by 1`);
  const counts: Record<string, number> = {};
  for (const { name } of tables) {
    const [schema, table] = (name as string).split('.');
    counts[name as string] = Number((await pool.query(`select count(*)::int as n from "${schema}"."${table}"`)).rows[0].n);
  }
  return {
    counts,
    rls: await q(`select n.nspname, c.relname, c.relrowsecurity, c.relforcerowsecurity from pg_class c join pg_namespace n on n.oid = c.relnamespace
                   where c.relkind in ('r', 'p') and n.nspname = any($1) order by 1, 2`),
    policies: await q(`select schemaname, tablename, policyname, permissive, roles::text, cmd, qual, with_check from pg_policies where schemaname = any($1) order by 1, 2, 3`),
    functions: await q(`select n.nspname, p.proname, pg_get_function_identity_arguments(p.oid) as args, pg_get_userbyid(p.proowner) as owner, p.prosecdef,
                               p.proleakproof, coalesce(p.proacl, acldefault('f', p.proowner))::text as acl, md5(pg_get_functiondef(p.oid)) as def
                          from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = any($1) and p.prokind in ('f', 'p') order by 1, 2, 3`),
    relations: await q(`select n.nspname, c.relname, c.relkind, pg_get_userbyid(c.relowner) as owner, coalesce(c.relacl, acldefault((case c.relkind when 'S' then 's' else 'r' end)::"char", c.relowner))::text as acl
                          from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = any($1) and c.relkind in ('r', 'p', 'v', 'm', 'S') order by 1, 2`),
    columns: await q(`select n.nspname, c.relname, a.attname, a.attacl::text as acl from pg_attribute a join pg_class c on c.oid = a.attrelid join pg_namespace n on n.oid = c.relnamespace
                       where n.nspname = any($1) and a.attacl is not null and not a.attisdropped order by 1, 2, 3`),
    schemas: await q(`select nspname, pg_get_userbyid(nspowner) as owner, coalesce(nspacl, acldefault('n', nspowner))::text as acl from pg_namespace where nspname = any($1) order by 1`),
    defaults: await q(`select pg_get_userbyid(defaclrole) as role, coalesce(n.nspname, '') as schema, defaclobjtype, defaclacl::text as acl
                         from pg_default_acl d left join pg_namespace n on n.oid = d.defaclnamespace order by 1, 2, 3`),
    triggers: await q(`select n.nspname, c.relname, t.tgname, t.tgenabled, md5(pg_get_triggerdef(t.oid)) as def from pg_trigger t join pg_class c on c.oid = t.tgrelid
                        join pg_namespace n on n.oid = c.relnamespace where not t.tgisinternal and n.nspname = any($1) order by 1, 2, 3`),
    // Проверка с BETWEEN внутри AND после разбора текста копии теряет одну пару скобок: смысл тот же, сравнение без скобок.
    constraints: await q(`select n.nspname, c.relname, k.conname, md5(regexp_replace(pg_get_constraintdef(k.oid), '[()]', '', 'g')) as def, k.convalidated from pg_constraint k join pg_class c on c.oid = k.conrelid
                           join pg_namespace n on n.oid = c.relnamespace where n.nspname = any($1) order by 1, 2, 3`),
    indexes: await q(`select schemaname, tablename, indexname, md5(indexdef) as def from pg_indexes where schemaname = any($1) order by 1, 2, 3`),
    sequences: await q(`select schemaname, sequencename, last_value from pg_sequences where schemaname = any($1) order by 1, 2`),
    extensions: (await pool.query(`select extname, extversion, extnamespace::regnamespace::text as schema from pg_extension order by 1`)).rows,
    members: (
      await pool.query(`select r.rolname as role, m.rolname as member, a.admin_option, a.inherit_option, a.set_option from pg_auth_members a
                          join pg_roles r on r.oid = a.roleid join pg_roles m on m.oid = a.member where r.rolname like 'hub%' or m.rolname like 'hub%' order by 1, 2`)
    ).rows,
    leakproofIlike: (await pool.query(`select proleakproof from pg_proc where oid = 'pg_catalog.texticlike(text, text)'::regprocedure`)).rows[0].proleakproof as boolean,
    database: (await pool.query(`select pg_get_userbyid(datdba) as owner, datacl::text as acl from pg_database where datname = current_database()`)).rows[0],
  };
}

/**
 * Сверх набора изоляции: строки таблиц входа, которые набор не заполняет (пароль, второй фактор, проверка, SSO), и
 * настоящий запечатанный секрет (в наборе изоляции строка только вида запечатанной).
 */
async function seedRest(f: { l1: { userId: string } }): Promise<void> {
  const user = f.l1.userId;
  await pools.root.query(`insert into auth."account" ("accountId", "providerId", "userId", "password", "updatedAt") values ($1::text, 'credential', $1::uuid, 'hash', now())`, [user]);
  await pools.root.query(`insert into auth."twoFactor" ("secret", "backupCodes", "userId", "verified") values ('sealed-secret', 'codes', $1, true)`, [user]);
  await pools.root.query(`insert into auth."verification" ("identifier", "value", "expiresAt") values ('email-verification', 'token', now() + interval '1 hour')`);
  await pools.root.query(`insert into auth."ssoProvider" ("issuer", "userId", "providerId", "domain") values ('https://sso.smartup.example', $1, 'smartup-test', 'smartup.example')`, [user]);
  const sealed = getSecretBox().seal('бот-дежурных-секрет', SECRET_CONTEXT);
  await pools.root.query(`insert into hdn_channel_secrets (code, sealed) values ('oncall_telegram_bot', $1) on conflict (code) do update set sealed = excluded.sealed`, [sealed]);
}

/** Команда в контейнере восстановления; ненулевой код: ошибка с выводом команды. */
async function run(command: string[]): Promise<string> {
  const result = await target.exec(command);
  if (result.exitCode !== 0) throw new Error(`${command.join(' ')}: ${result.output}`);
  return result.output;
}

/** Адрес исходной базы изнутри контейнера восстановления: через шлюз сети Docker к порту на машине. */
async function sourceUrlFromTarget(): Promise<string> {
  const route = await run(['cat', '/proc/net/route']);
  const gateway = route
    .split('\n')
    .map((line) => line.trim().split(/\s+/))
    .find((cols) => cols[1] === '00000000' && cols[2] && cols[2] !== '00000000')?.[2];
  if (!gateway) throw new Error('не найден шлюз сети контейнера');
  const ip = [6, 4, 2, 0].map((i) => parseInt(gateway.slice(i, i + 2), 16)).join('.');
  const source = new URL(process.env.DATABASE_URL_SUPERUSER!);
  source.hostname = ip;
  source.pathname = '/hub';
  return source.toString();
}

test('копия pg_dump восстанавливается в чистую базу после bootstrap: строки, RLS, политики, владельцы и права те же, портал работает', async () => {
  const f = await seedEverything();
  await seedRest(f);
  // Контексты до копии: строки сессий попадают в копию, после восстановления портал читает их из новой базы.
  const client = await clientCtx(f.aUser);
  const l1 = staffCtx(f.l1);
  const bOpen = (await pools.root.query(`select number from hdi_ideas where status = 'open' and org_id = $1`, [f.orgB.orgId])).rows[0].number as number;
  const source = await snapshot(pools.root);

  // Каждая таблица со строками: пустая таблица не проверяет копию.
  const empty = Object.entries(source.counts)
    .filter(([name, n]) => n === 0 && !name.startsWith('pgboss.'))
    .map(([name]) => name);
  expect(empty).toEqual([]);
  // Что именно держит изоляцию, проверяется и на исходной базе: иначе совпадение копии ничего не значит.
  const publicTables = source.rls.filter((r) => r.nspname === 'public');
  // Те же таблицы, что в наборе изоляции: копия проверяется на каждой таблице предметной области.
  expect(publicTables.length).toBeGreaterThanOrEqual(70);
  for (const table of publicTables) expect(Object.keys(DOMAIN_OBJECTS), table.relname).toContain(table.relname);
  expect(publicTables.filter((r) => !(r.relrowsecurity && r.relforcerowsecurity)).map((r) => r.relname)).toEqual([]);
  const counterFunctions = source.functions.filter((r) => r.owner === 'hub_hdi_counter');
  expect(counterFunctions.length).toBeGreaterThanOrEqual(2);
  expect(counterFunctions.every((r) => r.prosecdef)).toBe(true);

  // backup.sh: pg_dump -U postgres -Fc hub. Памятка, шаг 4: pg_restore -U postgres -d hub --clean --if-exists --exit-on-error.
  const started = performance.now();
  await run(['pg_dump', '-Fc', '-f', '/tmp/hub.dump', '-d', await sourceUrlFromTarget()]);
  await run(['pg_restore', '-U', 'postgres', '-d', 'hub', '--clean', '--if-exists', '--exit-on-error', '/tmp/hub.dump']);
  // Шаг 6: миграции после восстановления. Образ той же версии: применять нечего.
  expect((await migrate({ ownerUrl: targetUrl('hub_owner', passwords.owner) })).applied).toBe(0);
  process.stdout.write(`восстановление: копия и pg_restore за ${Math.round(performance.now() - started)} мс\n`);

  const restored = await snapshot(targetSuper);
  // pg_restore пересчитывает статистику не всегда, последовательности pg-boss могут сдвинуться от его опроса.
  for (const key of ['counts', 'rls', 'policies', 'functions', 'relations', 'columns', 'schemas', 'defaults', 'triggers', 'constraints', 'indexes', 'extensions', 'members'] as const)
    expect(restored[key], key).toEqual(source[key]);
  expect(restored.sequences.filter((s) => s.schemaname === 'public')).toEqual(source.sequences.filter((s) => s.schemaname === 'public'));
  expect(restored.database).toEqual(source.database);
  // Отметка ILIKE как безопасного живёт в pg_catalog и в копию не входит: её ставит bootstrap (шаг 2) до восстановления.
  expect(restored.leakproofIlike).toBe(true);
  // Памятка, шаг 7: ни одной таблицы public без ENABLE и FORCE.
  const weak = await targetSuper.query(`select count(*)::int as n from pg_class where relkind = 'r' and relnamespace = 'public'::regnamespace and not (relrowsecurity and relforcerowsecurity)`);
  expect(weak.rows[0].n).toBe(0);
  // Запечатанный секрет открывается тем же ключом после восстановления.
  const sealed = (await targetSuper.query(`select sealed from hdn_channel_secrets where code = 'oncall_telegram_bot'`)).rows[0].sealed as string;
  expect(getSecretBox().open(sealed, SECRET_CONTEXT)).toBe('бот-дежурных-секрет');

  // Портал на восстановленной базе: пулы приложения и входа смотрят в неё.
  const appPool = new Pool({ connectionString: targetUrl('hub_app', passwords.app), max: 4 });
  const authPool = new Pool({ connectionString: targetUrl('hub_auth', passwords.auth), max: 2 });
  await closeAppPool();
  await closeAuthPool();
  const shared = globalThis as typeof globalThis & { __hubAppPool?: Pool; __hubAuthPool?: Pool };
  shared.__hubAppPool = appPool;
  shared.__hubAuthPool = authPool;
  try {
    // Без актора приложение строк не видит.
    expect((await appPool.query(`select count(*)::int as n from hdt_tickets`)).rows[0].n).toBe(0);
    const own = await listTickets(client, {});
    expect(own.items.map((t) => t.number).sort()).toEqual([f.tickets.aOrg.number, f.tickets.aMine.number].sort());
    expect((await getTicket(client, String(f.tickets.aOrg.number)))?.title).toBe(f.tickets.aOrg.title);
    expect(await getTicket(client, String(f.tickets.bOrg.number))).toBeNull();
    const queue = await listQueue(l1, { queue: 'all', sort: 'updated', page: 1 });
    expect(queue.items.length).toBe(Object.keys(f.tickets).length);
    // Голос идёт через функции счётчика (SECURITY DEFINER у hub_hdi_counter): снять и поставить снова.
    const before = (await ideaPage(client, { number: bOpen, locale: 'ru' }))!;
    expect(before.voted).toBe(true);
    await unvoteIdea(client, { number: bOpen });
    expect((await ideaPage(client, { number: bOpen, locale: 'ru' }))!.voteCount).toBe(before.voteCount - 1);
    await voteIdea(client, { number: bOpen });
    expect((await ideaPage(client, { number: bOpen, locale: 'ru' }))!.voteCount).toBe(before.voteCount);
    // Очередь задач: портал ставит задачу под hub_app, фоновый процесс её берёт.
    const boss = new PgBoss(bossOptions(targetUrl('hub_app', passwords.app), 'sender'));
    await boss.start();
    try {
      // Очередь без ограничения "одна ждущая": в копии могут быть задачи, поставленные до неё.
      const id = await boss.send('kb.translate', { restoreCheck: true });
      expect(id).toBeTruthy();
      const jobs = await boss.fetch('kb.translate', { batchSize: 100 });
      expect(jobs.map((job) => job.id)).toContain(id);
    } finally {
      await boss.stop({ graceful: false });
    }
  } finally {
    await closeAppPool();
    await closeAuthPool();
  }
}, 300_000);
