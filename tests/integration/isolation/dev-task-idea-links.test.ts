import type { PoolClient } from 'pg';
import { beforeEach, expect, test } from 'vitest';
import type { Actor } from '@/db/with-actor';
import { staffWithRole } from '../helpers/auth';
import { asActor, pools } from '../helpers/db';
import { type Fixture, seedTwoOrgs } from './fixture';
import { addIdea } from './ideas-fixture';

// Привязка идеи к задаче разработки (план M7, задача 9, решение 18; миграция 0082) прямыми запросами под hub_app.
// Главное: защита привязок обращений осталась прежней (те же роли вставляют и удаляют, клиент не видит ничего), а
// привязку идеи ставят только product и admin, снять её не может никто. В строке ровно одно из обращения и идеи.

let f: Fixture;
let taskId: string;
let ideaId: string;

beforeEach(async () => {
  f = await seedTwoOrgs();
  taskId = (
    await pools.root.query(`insert into hdw_dev_tasks (tracker, external_id, url, title) values ('manual', $1, 'https://tracker.smartup.example/tasks/1', 'Задача') returning dev_task_id`, [
      `DEV-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    ])
  ).rows[0].dev_task_id as string;
  ideaId = (await addIdea(f.orgB.orgId, f.bUser, 'selected')).ideaId;
});

const staff = async (role: 'agent_l1' | 'agent_l2' | 'care' | 'product' | 'admin'): Promise<Actor> => (await staffWithRole(role)).actor;
const run = <T>(actor: Actor, fn: (c: PoolClient) => Promise<T>) => asActor(pools.app, actor, fn);
const linkTicket = (actor: Actor) =>
  run(actor, (c) => c.query(`insert into hdw_dev_task_links (org_id, dev_task_id, ticket_id) values ($1, $2, $3) returning link_id`, [f.orgA.orgId, taskId, f.tickets.aOrg.ticketId]));
const linkIdea = (actor: Actor, extra: { orgId?: string } = {}) =>
  run(actor, (c) => c.query(`insert into hdw_dev_task_links (org_id, dev_task_id, idea_id) values ($1, $2, $3) returning link_id`, [extra.orgId ?? null, taskId, ideaId]));
const policies = async () =>
  Object.fromEntries(
    (await pools.root.query(`select policyname, cmd, qual, with_check from pg_policies where tablename = 'hdw_dev_task_links' order by policyname`)).rows.map((r) => [
      r.policyname as string,
      { cmd: r.cmd as string, qual: r.qual as string | null, check: r.with_check as string | null },
    ]),
  );

test('политики: прежние только сужены условием ticket_id IS NOT NULL, чтение то же, у идеи своя вставка и нет удаления', async () => {
  const p = await policies();
  // Веха M5c, задача 8 (миграция 0105): две политики только для строк известных проблем.
  expect(Object.keys(p)).toEqual([
    'hdw_dev_task_links_developer_delete',
    'hdw_dev_task_links_developer_insert',
    'hdw_dev_task_links_internal_select',
    'hdw_dev_task_links_moderator_insert',
    'hdw_dev_task_links_problem_delete',
    'hdw_dev_task_links_problem_insert',
  ]);
  expect(p.hdw_dev_task_links_problem_insert?.check).toMatch(/^\(\(known_problem_id IS NOT NULL\) AND \(ticket_id IS NULL\) AND \(idea_id IS NULL\) AND \(org_id IS NULL\) AND app\.hdp_can_write\(\)\)$/);
  expect(p.hdw_dev_task_links_problem_delete?.qual).toMatch(/^\(\(known_problem_id IS NOT NULL\) AND app\.hdp_can_write\(\)\)$/);
  expect(p.hdw_dev_task_links_internal_select).toEqual({ cmd: 'SELECT', qual: 'app.is_internal()', check: null });
  expect(p.hdw_dev_task_links_developer_insert?.check).toMatch(/^\(\(ticket_id IS NOT NULL\) AND \(app\.actor_type\(\) = 'staff'::text\) AND \(app\.staff_role\(\) = ANY \(ARRAY\['agent_l2'::text, 'care'::text, 'admin'::text\]\)\)\)$/);
  expect(p.hdw_dev_task_links_developer_delete?.qual).toMatch(/^\(\(ticket_id IS NOT NULL\) AND \(app\.actor_type\(\) = 'staff'::text\) AND \(app\.staff_role\(\) = ANY \(ARRAY\['agent_l2'::text, 'care'::text, 'admin'::text\]\)\)\)$/);
  expect(p.hdw_dev_task_links_moderator_insert?.check).toContain(`ARRAY['product'::text, 'admin'::text]`);
  expect(p.hdw_dev_task_links_moderator_insert?.check).toContain('idea_id IS NOT NULL');
});

test('привязка обращения: вставляют вторая линия, Customer Care и администратор; первая линия, product и клиент нет', async () => {
  for (const role of ['agent_l2', 'care', 'admin'] as const) {
    await expect(linkTicket(await staff(role))).resolves.toBeTruthy();
    await pools.root.query(`delete from hdw_dev_task_links`);
  }
  for (const actor of [await staff('agent_l1'), await staff('product'), f.aAdmin.actor, f.aUser.actor])
    await expect(linkTicket(actor)).rejects.toThrow(/row-level security/);
});

test('привязка обращения: снимают те же роли; product и первая линия не снимают, клиент её не видит', async () => {
  await linkTicket(await staff('agent_l2'));
  for (const actor of [await staff('product'), await staff('agent_l1'), f.aAdmin.actor]) {
    const r = await run(actor, (c) => c.query(`delete from hdw_dev_task_links where ticket_id = $1`, [f.tickets.aOrg.ticketId]));
    expect(r.rowCount).toBe(0);
  }
  expect((await run(f.aAdmin.actor, (c) => c.query(`select * from hdw_dev_task_links`))).rows).toEqual([]);
  const removed = await run(await staff('care'), (c) => c.query(`delete from hdw_dev_task_links where ticket_id = $1`, [f.tickets.aOrg.ticketId]));
  expect(removed.rowCount).toBe(1);
});

test('привязка идеи: ставят только product и admin; вторая линия, Customer Care, первая линия и клиент нет', async () => {
  for (const role of ['product', 'admin'] as const) {
    await expect(linkIdea(await staff(role))).resolves.toBeTruthy();
    await pools.root.query(`delete from hdw_dev_task_links`);
  }
  for (const actor of [await staff('agent_l2'), await staff('care'), await staff('agent_l1'), f.bUser.actor, f.bAdmin.actor])
    await expect(linkIdea(actor)).rejects.toThrow(/row-level security/);
});

test('привязку идеи не снимает никто, клиент её не видит; у идеи одна задача', async () => {
  await linkIdea(await staff('product'));
  for (const actor of [await staff('admin'), await staff('product'), await staff('agent_l2'), await staff('care')]) {
    const r = await run(actor, (c) => c.query(`delete from hdw_dev_task_links where idea_id = $1`, [ideaId]));
    expect(r.rowCount).toBe(0);
  }
  for (const actor of [f.bUser.actor, f.aUser.actor]) expect((await run(actor, (c) => c.query(`select * from hdw_dev_task_links`))).rows).toEqual([]);
  expect((await run(await staff('agent_l1'), (c) => c.query(`select idea_id from hdw_dev_task_links`))).rows).toEqual([{ idea_id: ideaId }]);
  await expect(linkIdea(await staff('admin'))).rejects.toThrow(/hdw_dev_task_links_u3/);
});

test('ровно одно: обе ссылки, ни одной, идея с организацией и обращение без организации отклоняет база', async () => {
  const product = await staff('product');
  await expect(linkIdea(product, { orgId: f.orgB.orgId })).rejects.toThrow();
  await expect(
    pools.root.query(`insert into hdw_dev_task_links (org_id, dev_task_id, ticket_id, idea_id) values ($1, $2, $3, $4)`, [f.orgA.orgId, taskId, f.tickets.aOrg.ticketId, ideaId]),
  ).rejects.toThrow(/hdw_dev_task_links_c1/);
  await expect(pools.root.query(`insert into hdw_dev_task_links (dev_task_id) values ($1)`, [taskId])).rejects.toThrow(/hdw_dev_task_links_c1/);
  await expect(pools.root.query(`insert into hdw_dev_task_links (dev_task_id, ticket_id) values ($1, $2)`, [taskId, f.tickets.aOrg.ticketId])).rejects.toThrow(/hdw_dev_task_links_c1/);
  await expect(pools.root.query(`insert into hdw_dev_task_links (org_id, dev_task_id, idea_id) values ($1, $2, $3)`, [f.orgB.orgId, taskId, ideaId])).rejects.toThrow(/hdw_dev_task_links_c1/);
  // Обращение чужой организации внешний ключ f2 по-прежнему не принимает.
  await expect(
    pools.root.query(`insert into hdw_dev_task_links (org_id, dev_task_id, ticket_id) values ($1, $2, $3)`, [f.orgB.orgId, taskId, f.tickets.aOrg.ticketId]),
  ).rejects.toThrow(/hdw_dev_task_links_f2/);
});

test('задачу разработки заводит product, статус задачи он не меняет; клиент задач не видит', async () => {
  const product = await staff('product');
  const created = await run(product, (c) => c.query(`insert into hdw_dev_tasks (tracker, external_id, url) values ('manual', $1, 'https://tracker.smartup.example/tasks/9') returning dev_task_id`, [`IDEA-${Date.now()}`]));
  expect(created.rowCount).toBe(1);
  const updated = await run(product, (c) => c.query(`update hdw_dev_tasks set status = 'done' where dev_task_id = $1`, [taskId]));
  expect(updated.rowCount).toBe(0);
  await expect(run(await staff('agent_l1'), (c) => c.query(`insert into hdw_dev_tasks (tracker, external_id, url) values ('manual', 'X-1', 'https://tracker.smartup.example/tasks/x')`))).rejects.toThrow(/row-level security/);
  expect((await run(f.aUser.actor, (c) => c.query(`select * from hdw_dev_tasks`))).rows).toEqual([]);
});

test('итоговая проверка M7, M3: product заводит только открытую задачу без отметки напоминания и без сверки (кроме только что сверенной задачи API)', async () => {
  const product = await staff('product');
  const insert = (values: { tracker?: string; status?: string; closedNotified?: boolean; synced?: string | null }) =>
    run(product, (c) =>
      c.query(
        `insert into hdw_dev_tasks (tracker, external_id, url, title, status, closed_notified_on, synced_on)
         values ($1, $2, 'https://tracker.smartup.example/tasks/9', 'Задача идеи', $3, case when $4 then now() end, $5::timestamptz) returning dev_task_id`,
        [values.tracker ?? 'manual', `IDEA-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, values.status ?? 'todo', values.closedNotified ?? false, values.synced ?? null],
      ),
    );
  await expect(insert({})).resolves.toBeTruthy();
  await expect(insert({ status: 'in_progress' })).resolves.toBeTruthy();
  await expect(insert({ tracker: 'smartup', synced: new Date(Date.now() - 1000).toISOString() })).resolves.toBeTruthy();
  for (const values of [{ status: 'done' }, { status: 'cancelled' }, { closedNotified: true }, { synced: new Date().toISOString() }, { tracker: 'smartup', synced: '2999-01-01T00:00:00Z' }])
    await expect(insert(values), JSON.stringify(values)).rejects.toThrow(/row-level security/);
});
