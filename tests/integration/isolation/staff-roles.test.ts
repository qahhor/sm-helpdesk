import { expect, test } from 'vitest';
import type { Actor } from '@/db/with-actor';
import { replyToTicket } from '@/modules/hdt/api';
import { clientCtx, staffWithRole } from '../helpers/auth';
import { asActor, pools } from '../helpers/db';
import { seedTwoOrgs } from './fixture';

// Права сотрудников по ролям (ТЗ 5.2, 5.3, 10.3; план M3, задача 4): строки "нет" обеспечивает база.

const run = (actor: Actor, sql: string, params: unknown[] = []) => asActor(pools.app, actor, (c) => c.query(sql, params)).then((r) => r.rowCount);
const rows = (actor: Actor, sql: string, params: unknown[] = []) => asActor(pools.app, actor, (c) => c.query(sql, params)).then((r) => r.rows);
const waitingSince = (ticketId: string) =>
  pools.root.query(`select client_waiting_since from hdt_tickets where ticket_id = $1`, [ticketId]).then((r) => r.rows[0].client_waiting_since as Date | null);

test('product читает обращения, сообщения и заметки, но не меняет ничего (row-level security)', async () => {
  const f = await seedTwoOrgs();
  const product = (await staffWithRole('product')).actor;
  const t = f.tickets.aOrg;
  expect((await rows(product, 'select 1 from hdt_tickets')).length).toBe(5);
  expect((await rows(product, 'select 1 from hdt_ticket_messages where ticket_id = $1 and is_internal', [t.ticketId])).length).toBe(1);
  // Ни одной записи: ни обращения, ни сообщения, ни события, ни подписки, ни вложения.
  expect(await run(product, `update hdt_tickets set priority = 'p1' where ticket_id = $1`, [t.ticketId])).toBe(0);
  for (const sql of [
    `insert into hdt_ticket_messages (org_id, ticket_id, author_id, author_type, body, is_internal) values ($1, $2, $3, 'staff', 'x', true)`,
    `insert into hdt_ticket_events (org_id, ticket_id, kind, actor_type, actor_id, is_internal) values ($1, $2, 'priority', 'staff', $3, true)`,
    `insert into hdt_ticket_watchers (org_id, ticket_id, user_id, source) values ($1, $2, $3, 'manual')`,
  ])
    await expect(run(product, sql, [f.orgA.orgId, t.ticketId, product.type === 'staff' ? product.userId : '']), sql).rejects.toThrow(/row-level security/);
  // Первая линия те же записи делает.
  expect(await run(f.l1.actor, `update hdt_tickets set priority = 'p1' where ticket_id = $1`, [t.ticketId])).toBe(1);
  expect(
    await run(f.l1.actor, `insert into hdt_ticket_messages (org_id, ticket_id, author_id, author_type, body, is_internal) values ($1, $2, $3, 'staff', 'x', true)`, [
      f.orgA.orgId,
      t.ticketId,
      f.l1.userId,
    ]),
  ).toBe(1);
});

test('сотрудник не меняет организацию, автора, номер, канал и оценку обращения (42501)', async () => {
  const f = await seedTwoOrgs();
  const set = (change: string) => run(f.l1.actor, `update hdt_tickets set ${change} where ticket_id = $1`, [f.tickets.aOrg.ticketId]);
  for (const change of [
    `org_id = '${f.orgB.orgId}'`,
    `author_id = '${f.bUser.userId}'`,
    `number = 999999`,
    `created_on = now() - interval '1 year'`,
    `source = 'email'`,
    `csat_score = 5`,
    `csat_comment = 'за клиента'`,
    `last_client_message_on = now()`,
    `client_waiting_since = now() - interval '1 day'`,
  ])
    await expect(set(change), change).rejects.toThrow(/нельзя/);
  // Рабочие колонки сотрудник меняет; "клиент ждёт с" может только снять (ответил клиенту).
  expect(await set(`status = 'in_progress', priority = 'p2', assignee_id = '${f.l1.userId}', queue = 'l2'`)).toBe(1);
  expect(await set(`client_waiting_since = null`)).toBe(1);
});

test('client_waiting_since ставит база: при создании и сообщении клиента; заметка и смена статуса не трогают', async () => {
  const f = await seedTwoOrgs();
  const t = f.tickets.aOrg;
  // Обращения набора созданы суперпользователем: отметка ставится при вставке любым актором.
  const created = await waitingSince(t.ticketId);
  expect(created).not.toBeNull();
  await pools.root.query(`update hdt_tickets set client_waiting_since = null where ticket_id = $1`, [t.ticketId]);
  await replyToTicket(await clientCtx(f.aUser), { number: t.number, body: 'Ещё подробности', attachmentIds: [] });
  const afterReply = await waitingSince(t.ticketId);
  expect(afterReply).not.toBeNull();
  // Второе сообщение клиента без ответа не сдвигает отметку: ждёт он с первого.
  await replyToTicket(await clientCtx(f.aUser), { number: t.number, body: 'И ещё', attachmentIds: [] });
  expect((await waitingSince(t.ticketId))?.toISOString()).toBe(afterReply?.toISOString());
  // Заметка и смена статуса сотрудником отметку не трогают.
  await run(f.l1.actor, `insert into hdt_ticket_messages (org_id, ticket_id, author_id, author_type, body, is_internal) values ($1, $2, $3, 'staff', 'заметка', true)`, [
    f.orgA.orgId,
    t.ticketId,
    f.l1.userId,
  ]);
  await run(f.l1.actor, `update hdt_tickets set status = 'in_progress' where ticket_id = $1`, [t.ticketId]);
  expect((await waitingSince(t.ticketId))?.toISOString()).toBe(afterReply?.toISOString());
  // Клиент сам отметку не ставит и не снимает.
  await expect(run(f.aUser.actor, `update hdt_tickets set client_waiting_since = null where ticket_id = $1`, [t.ticketId])).rejects.toThrow(/нельзя/);
});

test('клиент не видит событий приоритета, исполнителя, линии, типа, модуля и отложения: база не даёт записать их видимыми', async () => {
  const f = await seedTwoOrgs();
  const t = f.tickets.aOrg;
  for (const kind of ['priority', 'assignee', 'queue', 'due', 'type', 'module', 'snooze'])
    await expect(
      run(f.l1.actor, `insert into hdt_ticket_events (org_id, ticket_id, kind, actor_type, actor_id, is_internal) values ($1, $2, $3, 'staff', $4, false)`, [
        f.orgA.orgId,
        t.ticketId,
        kind,
        f.l1.userId,
      ]),
      kind,
    ).rejects.toThrow(/hdt_ticket_events_c3|check constraint/);
  // Внутренними они пишутся, клиент их не видит; статус клиенту виден.
  for (const [kind, internal] of [
    ['priority', true],
    ['status', false],
  ] as const)
    await run(f.l1.actor, `insert into hdt_ticket_events (org_id, ticket_id, kind, actor_type, actor_id, is_internal) values ($1, $2, $3, 'staff', $4, $5)`, [
      f.orgA.orgId,
      t.ticketId,
      kind,
      f.l1.userId,
      internal,
    ]);
  const seen = (await rows(f.aUser.actor, `select kind from hdt_ticket_events where ticket_id = $1 order by kind`, [t.ticketId])).map((r) => r.kind);
  expect(seen).toEqual(['created', 'status']);
});
