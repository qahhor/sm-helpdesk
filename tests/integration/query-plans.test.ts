import { beforeEach, expect, test } from 'vitest';
import { listQueue, listTickets, queueCounts } from '@/modules/hdt/api';
import { MemoryJobQueue, setJobQueueForTests } from '@/modules/hdc/testing';
import { clientCtx, staffCtx } from './helpers/auth';
import { requeueStaleInbound } from '@/modules/hdn/api/inbound';
import { undeliveredMessages } from '@/modules/hdn/api/outbox';
import { PAUSED_STATUSES } from '@/modules/hdt/core/sla';
import { ticketsMinute } from '@/modules/hdt/api/jobs';
import { captureQueries, plansFor, seedBulkInbound, seedBulkTickets } from './helpers/bulk';
import { pools } from './helpers/db';
import { type Fixture, seedTwoOrgs } from './isolation/fixture';

// Планы горячих запросов на 50 тысячах обращений (аудит 23.11.2026, находки P1-P3, O7; план W1, задачи 1-3).
// Тест падает, если запрос списка или очереди снова делает полный просмотр таблицы обращений.

const SEQ_SCAN = /Seq Scan on hdt_tickets/;
let f: Fixture;

// Таблицы очищаются перед каждым тестом (setup/each.ts): набор заливается заново, это несколько секунд.
beforeEach(async () => {
  f = await seedTwoOrgs();
  await seedBulkTickets(50_000, 200, f.l1.userId);
}, 120_000);

test('набор залит: 50 тысяч обращений, большинство закрыты', async () => {
  const rows = (await pools.root.query(`select count(*)::int as n, count(*) filter (where status not in ('resolved', 'closed'))::int as open from hdt_tickets`)).rows[0];
  expect(rows.n).toBeGreaterThanOrEqual(50_000);
  expect(rows.open).toBeLessThan(rows.n / 3);
});

test('список обращений клиента идёт по индексу организации, а не просмотром всей таблицы (P1)', async () => {
  const ctx = await clientCtx(f.aUser);
  const { result, queries } = await captureQueries(() => listTickets(ctx, {}));
  expect(result.items.length).toBeGreaterThan(0);
  const plans = await plansFor(f.aUser.actor, queries, 'hdt_tickets');
  expect(plans.length).toBeGreaterThan(0);
  for (const plan of plans) expect(plan).not.toMatch(SEQ_SCAN);
});

test('счётчики очередей сотрудника не просматривают всю таблицу (P2)', async () => {
  const { queries } = await captureQueries(() => queueCounts(staffCtx(f.l1)));
  const plans = await plansFor(f.l1.actor, queries, 'hdt_tickets');
  expect(plans.length).toBeGreaterThan(0);
  for (const plan of plans) expect(plan).not.toMatch(SEQ_SCAN);
});

test.each(['new', 'mine', 'l2', 'waiting', 'development', 'breached'] as const)('первая страница очереди %s идёт по индексу (P2)', async (queue) => {
  const { queries } = await captureQueries(() => listQueue(staffCtx(f.l1), { queue }));
  const plans = await plansFor(f.l1.actor, queries, 'hdt_tickets');
  expect(plans.length).toBeGreaterThan(0);
  for (const plan of plans) expect(plan, plan).not.toMatch(SEQ_SCAN);
});

test('очередь "Все" по последнему изменению идёт по индексу (P2)', async () => {
  const { result, queries } = await captureQueries(() => listQueue(staffCtx(f.l1), { queue: 'all', sort: 'updated' }));
  expect(result.items.length).toBeGreaterThan(0);
  const plans = await plansFor(f.l1.actor, queries, 'hdt_tickets');
  for (const plan of plans) expect(plan, plan).not.toMatch(SEQ_SCAN);
});

test('счётчики считают открытые и "Мои", у очереди "Все" счётчика нет (P2)', async () => {
  const counts = await queueCounts(staffCtx(f.l1));
  expect(counts.all).toBeNull();
  const expected = (
    await pools.root.query(
      `select count(*) filter (where status = 'waiting_customer' and (snoozed_until is null or snoozed_until < now()))::int as waiting,
              count(*) filter (where status = 'in_development' and (snoozed_until is null or snoozed_until < now()))::int as development,
              count(*) filter (where assignee_id = $1 and status <> 'closed')::int as mine
         from hdt_tickets`,
      [f.l1.userId],
    )
  ).rows[0];
  expect(counts.waiting).toBe(expected.waiting);
  expect(counts.development).toBe(expected.development);
  expect(counts.mine).toBe(expected.mine);
  expect(counts.mine).toBeGreaterThan(0);
});

test('задача раз в минуту и возврат неразобранных писем не просматривают таблицы целиком (P3)', async () => {
  setJobQueueForTests(new MemoryJobQueue());
  await seedBulkInbound(20_000);
  const SYSTEM = { type: 'system', job: 'tickets.minute' } as const;
  try {
    const minute = await captureQueries(() => ticketsMinute(SYSTEM));
    for (const plan of await plansFor(SYSTEM, minute.queries, 'hdt_tickets')) expect(plan, plan).not.toMatch(SEQ_SCAN);
    const inbound = await captureQueries(() => requeueStaleInbound({ type: 'system', job: 'email.sweep' }));
    const plans = await plansFor(SYSTEM, inbound.queries, 'hdn_email_inbound');
    expect(plans.length).toBeGreaterThan(0);
    for (const plan of plans) expect(plan, plan).not.toMatch(/Seq Scan on hdn_email_inbound/);
  } finally {
    setJobQueueForTests(null);
  }
}, 120_000);

test('отметка "Письмо не доставлено" ищет по индексу сообщения, а не по всей очереди (P6)', async () => {
  await pools.root.query(
    `insert into hdn_outbox (ticket_id, channel, recipient_kind, recipient_user_id, template, payload, status, attempts, sent_on, external_id)
     select $1, 'email', 'user', $2, 'ticket_resolved', $3, 'sent', 1, now(), 'bulk-' || g from generate_series(1, 20000) g`,
    [f.tickets.aOrg.ticketId, f.aUser.userId, JSON.stringify({ template: 'ticket_resolved', number: 1, title: 'x', url: '/tickets' })],
  );
  await pools.root.query(`analyze hdn_outbox`);
  const ids = (await pools.root.query(`select message_id from hdt_ticket_messages limit 3`)).rows.map((row) => row.message_id as string);
  const { queries } = await captureQueries(() => undeliveredMessages(f.l1.actor, ids));
  const plans = await plansFor(f.l1.actor, queries, 'hdn_outbox');
  expect(plans.length).toBeGreaterThan(0);
  for (const plan of plans) expect(plan, plan).not.toMatch(/Seq Scan on hdn_outbox/);
});

test('список статусов с паузой срока совпадает с условием индекса hdt_tickets_i17 и запроса сверки', () => {
  expect([...PAUSED_STATUSES]).toEqual(['waiting_customer', 'resolved', 'closed']);
});
