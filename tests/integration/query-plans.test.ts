import { beforeEach, expect, test } from 'vitest';
import { listQueue, listTickets, queueCounts } from '@/modules/hdt/api';
import { MemoryJobQueue, setJobQueueForTests } from '@/modules/hdc/testing';
import { clientCtx, staffCtx } from './helpers/auth';
import { requeueStaleInbound } from '@/modules/hdn/api/inbound';
import { undeliveredMessages } from '@/modules/hdn/api/outbox';
import { PAUSED_STATUSES } from '@/modules/hdt/core/sla';
import { SERVICE_ORG_ID } from '@/modules/hdu/pref';
import { ticketsMinute } from '@/modules/hdt/api/jobs';
import { captureQueries, planOf, plansFor, seedBulkInbound, seedBulkTickets } from './helpers/bulk';
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
              count(*) filter (where assignee_id = $1 and status <> 'closed')::int as mine,
              count(*) filter (where status = 'new' and queue = 'l1' and org_id <> $2 and (snoozed_until is null or snoozed_until < now()))::int as new,
              count(*) filter (where queue = 'l2' and status not in ('resolved', 'closed') and (snoozed_until is null or snoozed_until < now()))::int as l2
         from hdt_tickets`,
      [f.l1.userId, SERVICE_ORG_ID],
    )
  ).rows[0];
  expect(counts.new).toBe(expected.new);
  expect(counts.new).toBeGreaterThan(0);
  expect(counts.l2).toBe(expected.l2);
  expect(counts.l2).toBeGreaterThan(0);
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
    const minutePlans = await plansFor(SYSTEM, minute.queries, 'hdt_tickets');
    expect(minutePlans.length).toBeGreaterThan(3);
    for (const plan of minutePlans) expect(plan, plan).not.toMatch(SEQ_SCAN);
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

// --- Листание по ключу (решение 0038, пункт 3; план W3, задача 5) ---

test('очередь "Все": следующая страница берётся по ключу последней строки, без смещения и без повторов', async () => {
  const l1 = staffCtx(f.l1);
  const seen = new Set<number>();
  let after: string | undefined;
  for (let page = 0; page < 4; page++) {
    const list = await listQueue(l1, { queue: 'all', sort: 'updated', ...(after ? { after } : {}) });
    expect(list.items).toHaveLength(50);
    for (const item of list.items) {
      expect(seen.has(item.number), `повтор SUP-${item.number} на странице ${page + 1}`).toBe(false);
      seen.add(item.number);
    }
    expect(list.nextCursor).toBeTruthy();
    after = list.nextCursor ?? undefined;
  }
  // Тот же порядок, что у листания номером страницы: по последнему изменению.
  const byPage = await listQueue(l1, { queue: 'all', sort: 'updated', page: 4 });
  const byKey = [...seen].slice(150, 200);
  expect(byKey).toEqual(byPage.items.map((item) => item.number));
  // Запрос страницы по ключу не несёт смещения и идёт по индексу сортировки с условием на ключ.
  const { queries } = await captureQueries(() => listQueue(l1, { queue: 'all', sort: 'updated', after }));
  const ticketQuery = queries.find((q) => /from "hdt_tickets"/.test(q.text) && /order by/i.test(q.text));
  expect(ticketQuery?.text).not.toMatch(/offset \$\d+/i);
  const plan = await planOf(f.l1.actor, ticketQuery!);
  expect(plan, plan).toMatch(/Index Cond: .*modified_on/);
  expect(plan, plan).not.toMatch(SEQ_SCAN);
});

test('негодный ключ листания отклоняется; у сортировки по сроку ключа нет, страницы идут номером', async () => {
  const l1 = staffCtx(f.l1);
  await expect(listQueue(l1, { queue: 'all', sort: 'updated', after: 'мусор' })).rejects.toMatchObject({ code: 'invalid_input' });
  const bySla = await listQueue(l1, { queue: 'all', sort: 'sla' });
  expect(bySla.nextCursor).toBeNull();
  expect(bySla.hasMore).toBe(true);
});

test('ключ листания с негодной датой отклоняется как неверные данные, а не ошибкой базы (проверка волны 3)', async () => {
  const bad = '2026-13-45T99:99:99.000000Z_00000000-0000-0000-0000-000000000000';
  await expect(listQueue(staffCtx(f.l1), { queue: 'all', sort: 'updated', after: bad })).rejects.toMatchObject({ code: 'invalid_input' });
});

test('строки с одним временем изменения на границе страниц не теряются и не повторяются (проверка волны 3)', async () => {
  // Пакетная задача пишет сотни строк одной транзакцией: время изменения у них одно.
  const root = await pools.root.connect();
  try {
    await root.query('begin');
    await root.query(`set local session_replication_role = replica`);
    await root.query(`update hdt_tickets set modified_on = date_trunc('second', now()) + interval '1 hour' where ticket_id in (select ticket_id from hdt_tickets order by ticket_id limit 130)`);
    await root.query('commit');
  } finally {
    root.release();
  }
  const l1 = staffCtx(f.l1);
  const seen: number[] = [];
  let after: string | undefined;
  for (let page = 0; page < 3; page++) {
    const list = await listQueue(l1, { queue: 'all', sort: 'updated', ...(after ? { after } : {}) });
    seen.push(...list.items.map((item) => item.number));
    after = list.nextCursor ?? undefined;
  }
  expect(new Set(seen).size).toBe(150);
  const same = (await pools.root.query(`select number from hdt_tickets where modified_on = (select max(modified_on) from hdt_tickets)`)).rows.map((r) => Number(r.number));
  expect(same).toHaveLength(130);
  for (const number of same) expect(seen, `SUP-${number}`).toContain(number);
});

// --- Поиск по тексту идёт по индексу (вопрос 19, решение владельца 24.11.2026; план W4, задача 2) ---

test('поиск сотрудника по тексту в очереди "Все" не просматривает таблицу обращений целиком', async () => {
  const l1 = staffCtx(f.l1);
  const { result, queries } = await captureQueries(() => listQueue(l1, { queue: 'all', sort: 'updated', q: 'обращение 4242' }));
  expect(result.items.length).toBeGreaterThan(0);
  const plans = await plansFor(f.l1.actor, queries, 'hdt_tickets');
  expect(plans.length).toBeGreaterThan(0);
  for (const plan of plans) expect(plan, plan).not.toMatch(SEQ_SCAN);
});

test('поиск клиента по тексту в своей организации не просматривает таблицу обращений целиком', async () => {
  const ctx = await clientCtx(f.aUser);
  const { queries } = await captureQueries(() => listTickets(ctx, { q: 'нагрузочное' }));
  const plans = await plansFor(f.aUser.actor, queries, 'hdt_tickets');
  expect(plans.length).toBeGreaterThan(0);
  for (const plan of plans) expect(plan, plan).not.toMatch(SEQ_SCAN);
});

test('событие "нет активности": просмотр молчащих обращений не читает таблицу обращений целиком (проверка M8, I5)', async () => {
  const { runNoActivityRules } = await import('@/modules/hdw/api/engine');
  const { saveRule, setRuleEnabled } = await import('@/modules/hdw/api/rules');
  const admin = staffCtx(f.adminStaff);
  const { ruleId } = await saveRule(admin, { name: 'Молчание', event: 'no_activity', hours: 24, conditions: { match: 'all', items: [{ field: 'priority', op: 'is', values: ['p1'] }] }, actions: [{ action: 'add_note', text: 'Молчание' }], isStop: false });
  await setRuleEnabled(admin, { ruleId, enabled: true });
  // Правило включено давно: граница включения не отсекает набор, просмотр идёт по всем открытым обращениям.
  await pools.root.query(`update hdw_rules set enabled_on = now() - interval '60 days' where rule_id = $1`, [ruleId]);
  const SYSTEM = { type: 'system', job: 'automation.process' } as const;
  const scan = await captureQueries(() => runNoActivityRules(SYSTEM));
  expect(scan.result.checked).toBeGreaterThan(1000);
  const plans = await plansFor(SYSTEM, scan.queries, 'hdt_tickets');
  expect(plans.length).toBeGreaterThan(3);
  for (const plan of plans) expect(plan, plan).not.toMatch(SEQ_SCAN);
}, 120_000);
