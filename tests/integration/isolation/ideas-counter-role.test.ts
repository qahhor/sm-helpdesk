import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test } from 'vitest';
import type { Actor } from '@/db/with-actor';
import { staffWithRole } from '../helpers/auth';
import { asActor, pools } from '../helpers/db';
import { seedTwoOrgs } from './fixture';
import { addIdea } from './ideas-fixture';

// Счётчики идей, возврат пятёрки и перенос голосов без подмены актора (итоговая проверка M7, I1 и M2; решение 0065,
// миграция 0084). Пересчёт идёт функциями SECURITY DEFINER узкой роли hub_hdi_counter без входа: она меняет только
// счётчики и возврат shortlisted -> open, политики RLS для неё только на эти операции. Вызвать функции hub_app
// может, но они пересчитывают по настоящим строкам и проверяют условия сами: вызов ничего не даёт.

const FUNCTIONS = ['hdi_merge_votes', 'hdi_recount_comments', 'hdi_recount_votes', 'hdi_return_shortlist'];
const counts = (ideaId: string) => pools.root.query(`select vote_count, org_count, comment_count, status from hdi_ideas where idea_id = $1`, [ideaId]).then((r) => r.rows[0]);
const product = async (): Promise<Actor> => (await staffWithRole('product')).actor;

test('роль hub_hdi_counter: без входа, не суперпользователь, не обходит RLS; владеет только функциями пересчёта', async () => {
  const role = await pools.root.query(`select rolcanlogin, rolsuper, rolbypassrls, rolcreaterole, rolcreatedb, rolinherit from pg_roles where rolname = 'hub_hdi_counter'`);
  expect(role.rows).toEqual([{ rolcanlogin: false, rolsuper: false, rolbypassrls: false, rolcreaterole: false, rolcreatedb: false, rolinherit: false }]);
  const owned = await pools.root.query(
    `select p.proname, p.prosecdef, p.proconfig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where p.proowner = 'hub_hdi_counter'::regrole order by p.proname`,
  );
  expect(owned.rows.map((r) => r.proname)).toEqual(FUNCTIONS);
  for (const row of owned.rows) {
    expect(row.prosecdef, row.proname).toBe(true);
    expect(row.proconfig, row.proname).toEqual(['search_path=pg_catalog, public']);
  }
  // Права на таблицы: чтение нужных колонок и правка только счётчиков и статуса идеи; ничего на схемы.
  const priv = (table: string, column: string, p: string) =>
    pools.root.query(`select has_column_privilege('hub_hdi_counter', $1, $2, $3) as ok`, [table, column, p]).then((r) => r.rows[0].ok as boolean);
  for (const column of ['vote_count', 'org_count', 'comment_count', 'status']) expect(await priv('hdi_ideas', column, 'UPDATE'), column).toBe(true);
  for (const column of ['author_name', 'merged_into_id', 'decline_reason', 'published_on', 'selected_cycle', 'org_id']) expect(await priv('hdi_ideas', column, 'UPDATE'), column).toBe(false);
  expect(await priv('hdi_comments', 'body', 'SELECT')).toBe(false);
  expect(await priv('hdi_cycles', 'explanation_ru', 'SELECT')).toBe(false);
  const schema = await pools.root.query(`select has_schema_privilege('hub_hdi_counter', 'app', 'CREATE') as app, has_schema_privilege('hub_hdi_counter', 'public', 'CREATE') as pub`);
  expect(schema.rows[0]).toEqual({ app: false, pub: false });
  // Вызвать функции может только hub_app (триггеры), не PUBLIC и не hub_auth.
  for (const name of FUNCTIONS) {
    const r = await pools.root.query(
      `select has_function_privilege('hub_app', p.oid, 'EXECUTE') as app, has_function_privilege('hub_auth', p.oid, 'EXECUTE') as auth
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'app' and p.proname = $1`,
      [name],
    );
    expect(r.rows[0], name).toEqual({ app: true, auth: false });
  }
});

test('политики роли hub_hdi_counter: только чтение, правка идеи и перенос голосов объединения', async () => {
  const r = await pools.root.query(`select tablename, policyname, cmd, qual, with_check from pg_policies where 'hub_hdi_counter' = any (roles) order by tablename, policyname`);
  expect(r.rows.map((row) => [row.tablename, row.policyname, row.cmd])).toEqual([
    ['hdi_comments', 'hdi_comments_counter_select', 'SELECT'],
    ['hdi_cycles', 'hdi_cycles_counter_select', 'SELECT'],
    ['hdi_ideas', 'hdi_ideas_counter_select', 'SELECT'],
    ['hdi_ideas', 'hdi_ideas_counter_update', 'UPDATE'],
    ['hdi_votes', 'hdi_votes_counter_delete', 'DELETE'],
    ['hdi_votes', 'hdi_votes_counter_insert', 'INSERT'],
    ['hdi_votes', 'hdi_votes_counter_select', 'SELECT'],
  ]);
  // Ни одна политика hub_app не открыта роли счётчиков и наоборот.
  const mixed = await pools.root.query(`select policyname from pg_policies where 'hub_hdi_counter' = any (roles) and cardinality(roles) > 1`);
  expect(mixed.rows).toEqual([]);
  // FORCE на месте.
  const force = await pools.root.query(`select relname from pg_class where relname in ('hdi_ideas', 'hdi_votes', 'hdi_comments', 'hdi_cycles') and not (relrowsecurity and relforcerowsecurity)`);
  expect(force.rows).toEqual([]);
});

test('ни одна миграция с 0084 не ставит переменные актора; прежних функций подмены актора нет', async () => {
  const dir = resolve('drizzle');
  const later = readdirSync(dir).filter((name) => /^\d{4}_/.test(name) && Number(name.slice(0, 4)) >= 84);
  expect(later.length).toBeGreaterThan(0);
  for (const name of later) expect(readFileSync(resolve(dir, name), 'utf8'), name).not.toMatch(/set_config\s*\(\s*'app\./);
  const helpers = await pools.root.query(`select proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'app' and proname in ('hdi_as_system', 'hdi_restore_actor')`);
  expect(helpers.rows).toEqual([]);
});

test('вызов функций пересчёта клиентом безвреден: счётчик становится равным count(*), чужая идея не меняется иначе', async () => {
  const f = await seedTwoOrgs();
  const open = await addIdea(f.orgB.orgId, f.bUser, 'open');
  const hidden = await addIdea(f.orgB.orgId, f.bUser, 'pending_review');
  await pools.root.query(`insert into hdi_votes (org_id, idea_id, user_id) values ($1, $2, $3)`, [f.orgA.orgId, open.ideaId, f.aUser.userId]);
  await pools.root.query(`insert into hdi_comments (org_id, idea_id, author_id, author_name, body) values ($1, $2, $3, $4, 'Да')`, [f.orgA.orgId, open.ideaId, f.aUser.userId, f.aUser.name]);
  // Счётчики расходятся с таблицами (например, после ручной правки суперпользователем).
  await pools.root.query(`update hdi_ideas set vote_count = 40, org_count = 9, comment_count = 7 where idea_id = any ($1)`, [[open.ideaId, hidden.ideaId]]);
  for (const id of [open.ideaId, hidden.ideaId])
    await asActor(pools.app, f.aAdmin.actor, async (c) => {
      await c.query(`select app.hdi_recount_votes($1)`, [id]);
      await c.query(`select app.hdi_recount_comments($1)`, [id]);
    });
  expect(await counts(open.ideaId)).toEqual({ vote_count: 1, org_count: 1, comment_count: 1, status: 'open' });
  expect(await counts(hidden.ideaId)).toEqual({ vote_count: 0, org_count: 0, comment_count: 0, status: 'pending_review' });
  // Клиент чужую идею на модерации по-прежнему не видит.
  expect((await asActor(pools.app, f.aAdmin.actor, (c) => c.query(`select 1 from hdi_ideas where idea_id = $1`, [hidden.ideaId]))).rows).toEqual([]);
});

test('возврат пятёрки и перенос голосов: функции сами проверяют условия, вызов клиентом и не вовремя ничего не меняет', async () => {
  const f = await seedTwoOrgs();
  const a = await addIdea(f.orgB.orgId, f.bUser, 'shortlisted');
  const b = await addIdea(f.orgB.orgId, f.bUser, 'shortlisted');
  const entry = (id: string, place: number) => ({ ideaId: id, number: place, voteCount: 1, orgCount: 1, place });
  // Прошлый отбор завершён с идеей a в пятёрке, текущий открыт и снова держит a; b только в прошлом.
  await pools.root.query(`insert into hdi_cycles (cycle, vote_mode, status, shortlist, leader_idea_id) values ('2091-01-01', 'per_user', 'lapsed', $1, $2)`, [
    JSON.stringify([entry(a.ideaId, 1), entry(b.ideaId, 2)]),
    a.ideaId,
  ]);
  const old = (await pools.root.query(`select cycle_id from hdi_cycles where cycle = '2091-01-01'`)).rows[0].cycle_id as string;
  await pools.root.query(`insert into hdi_cycles (cycle, vote_mode, status, shortlist, leader_idea_id) values ('2091-02-01', 'per_user', 'open', $1, $2)`, [JSON.stringify([entry(a.ideaId, 1)]), a.ideaId]);
  await asActor(pools.app, f.aUser.actor, (c) => c.query(`select app.hdi_return_shortlist($1)`, [old]));
  // a в открытом отборе: остаётся в шорт-листе; b ни в каком открытом: возвращается в голосование, как и должна была.
  expect((await counts(a.ideaId)).status).toBe('shortlisted');
  expect((await counts(b.ideaId)).status).toBe('open');
  const current = (await pools.root.query(`select cycle_id from hdi_cycles where cycle = '2091-02-01'`)).rows[0].cycle_id as string;
  await asActor(pools.app, await product(), (c) => c.query(`select app.hdi_return_shortlist($1)`, [current]));
  expect((await counts(a.ideaId)).status).toBe('shortlisted');
  await pools.root.query(`delete from hdi_cycles where cycle in ('2091-01-01', '2091-02-01')`);

  // Перенос голосов: клиенту нельзя; модератору только у объединённой идеи.
  const source = await addIdea(f.orgA.orgId, f.aUser, 'open');
  await pools.root.query(`insert into hdi_votes (org_id, idea_id, user_id) values ($1, $2, $3)`, [f.orgA.orgId, source.ideaId, f.aAdmin.userId]);
  await expect(asActor(pools.app, f.aUser.actor, (c) => c.query(`select app.hdi_merge_votes($1)`, [source.ideaId]))).rejects.toThrow(/нельзя/);
  await expect(asActor(pools.app, await product(), (c) => c.query(`select app.hdi_merge_votes($1)`, [source.ideaId]))).rejects.toThrow(/нельзя/);
  expect(await counts(source.ideaId)).toMatchObject({ vote_count: 1 });
});

test('M2: product не вставляет и не удаляет голоса прямым запросом; перенос голосов идёт только функцией объединения', async () => {
  const f = await seedTwoOrgs();
  const target = await addIdea(f.orgB.orgId, f.bUser, 'open');
  const source = await addIdea(f.orgA.orgId, f.aUser, 'open');
  await pools.root.query(`insert into hdi_votes (org_id, idea_id, user_id) values ($1, $2, $3), ($1, $2, $4)`, [f.orgA.orgId, source.ideaId, f.aUser.userId, f.aAdmin.userId]);
  const moderator = await product();
  await expect(asActor(pools.app, moderator, (c) => c.query(`insert into hdi_votes (org_id, idea_id, user_id) values ($1, $2, $3)`, [f.orgA.orgId, target.ideaId, f.aUser.userId]))).rejects.toThrow(
    /row-level security/,
  );
  expect((await asActor(pools.app, moderator, (c) => c.query(`delete from hdi_votes where idea_id = $1`, [source.ideaId]))).rowCount).toBe(0);
  const policies = await pools.root.query(`select policyname from pg_policies where tablename = 'hdi_votes' and policyname like '%moderator%'`);
  expect(policies.rows).toEqual([]);
  // Объединение: статус merged, затем перенос функцией той же транзакцией.
  const moved = await asActor(pools.app, moderator, async (c) => {
    await c.query(`update hdi_ideas set status = 'merged', merged_into_id = $2 where idea_id = $1`, [source.ideaId, target.ideaId]);
    return (await c.query(`select app.hdi_merge_votes($1) as n`, [source.ideaId])).rows[0].n as number;
  });
  expect(moved).toBe(2);
  expect(await counts(target.ideaId)).toMatchObject({ vote_count: 2, org_count: 1 });
  expect(await counts(source.ideaId)).toMatchObject({ vote_count: 0, org_count: 0 });
});
