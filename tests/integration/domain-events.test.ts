import { sql } from 'drizzle-orm';
import { beforeEach, expect, test } from 'vitest';
import { withActor } from '@/db/with-actor';
import { cleanupDomainEvents, DOMAIN_EVENT_KINDS, type DomainEvent, emitEventTx, EVENT_MAX_ATTEMPTS, JOB_NAMES, processEvents } from '@/modules/hdc/api';
import { replyAddress } from '@/modules/hdn/inbound/reply-address';
import {
  addTicketTag,
  confirmResolution,
  createTicket,
  createTicketForClient,
  mergeTicket,
  postStaffMessage,
  rateTicket,
  reopenTicket,
  replyToTicket,
  setPriority,
  setStatus,
  takeTicket,
  ticketsMinute,
} from '@/modules/hdt/api';
import { SCHEDULES } from '@/worker/main';
import { QUEUES } from '../../scripts/db/pgboss.mjs';
import { clientCtx, staffCtx, staffWithRole } from './helpers/auth';
import { asActor, pools } from './helpers/db';
import { deliver as deliverTo, inboundPerTest, REPLY } from './helpers/inbound';
import { type Fixture, seedTwoOrgs } from './isolation/fixture';

// События предметной области (FR-AUTO-02; план M8, задача 2, решение 3). Каждое изменение обращения пишет событие в
// hdc_domain_events в той же транзакции; фоновая задача automation.process разбирает события пачками. Пишет и
// разбирает только система и действие над обращением, клиент событий не видит.

const SYSTEM = { type: 'system', job: 'automation.process' } as const;
const MINUTE_JOB = { type: 'system', job: 'tickets.minute' } as const;
const MINUTE = 60_000;
const box = inboundPerTest();
let f: Fixture;

beforeEach(async () => {
  f = await seedTwoOrgs();
  await pools.root.query(`update auth."user" set email = 'a-user@example.uz', "emailVerified" = true, "lastOrgId" = $2 where id = $1`, [f.aUser.userId, f.orgA.orgId]);
});

type Row = { event_id: string; org_id: string; ticket_id: string; kind: string; payload: Record<string, unknown>; is_by_rule: boolean; processed_on: Date | null; attempts: number; last_error: string | null };
const allEvents = () => pools.root.query<Row>(`select * from hdc_domain_events order by event_id`).then((r) => r.rows);
const eventsOf = (ticketId: string) => pools.root.query<Row>(`select * from hdc_domain_events where ticket_id = $1 order by event_id`, [ticketId]).then((r) => r.rows);
const brief = (rows: Row[]) => rows.map((row) => [row.kind, row.payload]);
const clear = () => pools.root.query(`delete from hdc_domain_events`);
const ticketIdOf = (number: number) => pools.root.query(`select ticket_id, org_id from hdt_tickets where number = $1`, [number]).then((r) => r.rows[0] as { ticket_id: string; org_id: string });
const version = () => new Date(Date.now() + 5000).toISOString();
const staffReply = (ctx: ReturnType<typeof staffCtx>, number: number, extra: Record<string, unknown> = {}) =>
  postStaffMessage(ctx, { number, body: 'Проверьте настройки печати', internal: false, attachmentIds: [], waitForClient: false, seenVersion: version(), ...extra });
/** Событие строкой под суперпользователем: для проверок разбора. */
const seedEvent = (ticket: { ticketId: string }, orgId: string, kind = 'status_changed', payload: Record<string, unknown> = {}) =>
  pools.root
    .query(`insert into hdc_domain_events (org_id, ticket_id, kind, payload) values ($1, $2, $3, $4) returning event_id`, [orgId, ticket.ticketId, kind, JSON.stringify(payload)])
    .then((r) => r.rows[0].event_id as string);

test('перечень видов событий совпадает с ограничением базы', async () => {
  expect([...DOMAIN_EVENT_KINDS].sort()).toEqual(
    ['ai_handoff', 'client_replied', 'no_activity', 'priority_changed', 'rated', 'sla_breached', 'sla_soon', 'staff_replied', 'status_changed', 'ticket_created'].sort(),
  );
  for (const kind of DOMAIN_EVENT_KINDS) await seedEvent(f.tickets.aOrg, f.orgA.orgId, kind);
  await expect(seedEvent(f.tickets.aOrg, f.orgA.orgId, 'made_up')).rejects.toThrow(/hdc_domain_events_c1/);
});

test('создание обращения клиентом в портале: одно событие ticket_created в организации клиента', async () => {
  const { number } = await createTicket(await clientCtx(f.aUser), { description: 'Не печатается накладная', type: 'bug', impact: 'major', visibility: 'org', locale: 'ru' });
  const t = await ticketIdOf(number);
  const rows = await allEvents();
  expect(brief(rows)).toEqual([['ticket_created', { source: 'portal', type: 'bug', priority: 'p2' }]]);
  expect(rows[0]).toMatchObject({ org_id: f.orgA.orgId, ticket_id: t.ticket_id, is_by_rule: false, processed_on: null, attempts: 0 });
});

test('обращение от имени клиента и обращение из письма: по одному ticket_created со своим источником', async () => {
  const created = await createTicketForClient(staffCtx(f.l1), { orgId: f.orgA.orgId, authorId: f.aUser.userId, description: 'Клиент позвонил: не открывается отчёт', type: 'question', impact: 'minor', visibility: 'org', locale: 'ru', priority: 'p1' });
  expect(brief(await eventsOf((await ticketIdOf(created.number)).ticket_id))).toEqual([['ticket_created', { source: 'staff', type: 'question', priority: 'p1' }]]);
  await clear();
  const { result } = await deliverTo(box, { subject: 'Не печатается накладная', text: 'После обновления накладная не печатается' });
  expect(result).toBe('new');
  expect(brief(await allEvents())).toEqual([['ticket_created', { source: 'email', type: 'question', priority: 'p3' }]]);
});

test('ответ клиента в портале: client_replied, а из ожидания ещё и status_changed', async () => {
  const t = f.tickets.aOrg;
  const client = await clientCtx(f.aUser);
  await replyToTicket(client, { number: t.number, body: 'Версия 5.12, скриншот приложу позже' });
  expect(brief(await eventsOf(t.ticketId))).toEqual([['client_replied', { source: 'portal' }]]);
  await clear();
  await pools.root.query(`update hdt_tickets set status = 'waiting_customer', sla_paused_on = now() where ticket_id = $1`, [t.ticketId]);
  await replyToTicket(client, { number: t.number, body: 'Вот скриншот' });
  expect(brief(await eventsOf(t.ticketId))).toEqual([
    ['client_replied', { source: 'portal' }],
    ['status_changed', { from: 'waiting_customer', to: 'in_progress' }],
  ]);
});

test('ответ клиента письмом: client_replied с источником email; письмо на проверке события не пишет', async () => {
  const t = f.tickets.aOrg;
  const to = [replyAddress(t.number, f.aUser.userId, REPLY)];
  expect((await deliverTo(box, { to, text: 'Отвечаю письмом' })).result).toBe('reply');
  expect(brief(await eventsOf(t.ticketId))).toEqual([['client_replied', { source: 'email' }]]);
  await clear();
  expect((await deliverTo(box, { from: 'Someone <someone@other.uz>', to, text: 'Пересылаю вам' })).result).toBe('review');
  expect(await allEvents()).toEqual([]);
});

test('ответ сотрудника клиенту: staff_replied и смена статуса нового обращения; внутренняя заметка событий не пишет', async () => {
  const t = f.tickets.aOrg;
  const l1 = staffCtx(f.l1);
  expect(await staffReply(l1, t.number, { internal: true, body: 'Заметка для коллег' })).toEqual({ ok: true });
  expect(await allEvents()).toEqual([]);
  expect(await staffReply(l1, t.number)).toEqual({ ok: true });
  const rows = await eventsOf(t.ticketId);
  expect(rows.map((row) => row.kind).sort()).toEqual(['staff_replied', 'status_changed']);
  expect(rows.find((row) => row.kind === 'status_changed')?.payload).toEqual({ from: 'new', to: 'in_progress' });
  const messageId = (await pools.root.query(`select message_id from hdt_ticket_messages where ticket_id = $1 and author_type = 'staff' and not is_internal`, [t.ticketId])).rows[0].message_id;
  expect(rows.find((row) => row.kind === 'staff_replied')?.payload).toEqual({ messageId });
  // Второй ответ статус уже не меняет: одно событие.
  await clear();
  expect(await staffReply(l1, t.number)).toEqual({ ok: true });
  expect((await eventsOf(t.ticketId)).map((row) => row.kind)).toEqual(['staff_replied']);
  // В событии нет текста переписки.
  expect(JSON.stringify(await allEvents())).not.toContain('Проверьте настройки');
});

test('смена статуса и приоритета сотрудником: по одному событию с прежним и новым значением', async () => {
  const t = f.tickets.aOrg;
  const l1 = staffCtx(f.l1);
  await takeTicket(l1, t.number);
  expect(brief(await eventsOf(t.ticketId))).toEqual([['status_changed', { from: 'new', to: 'in_progress' }]]);
  await clear();
  await setStatus(l1, { number: t.number, to: 'resolved', resolution: 'solved' });
  expect(brief(await eventsOf(t.ticketId))).toEqual([['status_changed', { from: 'in_progress', to: 'resolved' }]]);
  await clear();
  await setPriority(l1, { number: t.number, priority: 'p1', reason: 'Стоит склад' });
  expect(brief(await eventsOf(t.ticketId))).toEqual([['priority_changed', { from: 'p2', to: 'p1' }]]);
  await clear();
  // Тот же приоритет: это подтверждение, а не изменение. Тег и исполнитель событий для правил не пишут.
  await setPriority(l1, { number: t.number, priority: 'p1', reason: 'Подтверждаю' });
  await addTicketTag(l1, { number: t.number, name: 'Срочно' });
  expect(await allEvents()).toEqual([]);
});

test('действия клиента: подтверждение, повторное открытие и оценка', async () => {
  const t = f.tickets.aOrg;
  const client = await clientCtx(f.aUser);
  await pools.root.query(`update hdt_tickets set status = 'resolved', resolved_on = now(), sla_paused_on = now() where ticket_id = $1`, [t.ticketId]);
  await reopenTicket(client, { number: t.number, body: 'Снова не работает' });
  expect(brief(await eventsOf(t.ticketId))).toEqual([
    ['client_replied', { source: 'portal' }],
    ['status_changed', { from: 'resolved', to: 'in_progress' }],
  ]);
  await clear();
  await pools.root.query(`update hdt_tickets set status = 'resolved', resolved_on = now() where ticket_id = $1`, [t.ticketId]);
  await confirmResolution(client, t.number);
  expect(brief(await eventsOf(t.ticketId))).toEqual([['status_changed', { from: 'resolved', to: 'closed' }]]);
  await clear();
  await rateTicket(client, { number: t.number, score: 2, reason: 'slow', comment: 'Долго отвечали' });
  expect(brief(await eventsOf(t.ticketId))).toEqual([['rated', { score: 2 }]]);
  expect(JSON.stringify(await allEvents())).not.toContain('Долго отвечали');
});

test('объединение дублей и автозакрытие системой пишут status_changed', async () => {
  const l1 = staffCtx(f.l1);
  await mergeTicket(l1, { number: f.tickets.aMine.number, intoNumber: f.tickets.aOrg.number });
  expect(brief(await allEvents())).toEqual([['status_changed', { from: 'new', to: 'closed' }]]);
  await clear();
  const t = f.tickets.aOrg;
  await pools.root.query(`update hdt_tickets set status = 'resolved', resolved_on = now() - interval '30 days', sla_paused_on = now() - interval '30 days' where ticket_id = $1`, [t.ticketId]);
  expect((await ticketsMinute(MINUTE_JOB, new Date())).closed).toBe(1);
  expect(brief(await eventsOf(t.ticketId))).toEqual([['status_changed', { from: 'resolved', to: 'closed' }]]);
});

test('откатившееся действие события не оставляет', async () => {
  const before = (await pools.root.query(`select count(*)::int as n from hdt_tickets`)).rows[0].n;
  // Обращение с чужим файлом: транзакция создания откатывается целиком.
  await expect(
    createTicket(await clientCtx(f.aUser), { description: 'С чужим файлом', type: 'bug', impact: 'major', visibility: 'org', locale: 'ru', attachmentIds: ['019a0000-0000-7000-8000-000000000001'] }),
  ).rejects.toMatchObject({ code: 'file_unavailable' });
  // Запрещённый переход и отказ в правах: ничего не изменилось, события нет.
  await expect(setStatus(staffCtx(f.l1), { number: f.tickets.aOrg.number, to: 'resolved', resolution: 'solved' })).rejects.toMatchObject({ code: 'transition_refused' });
  await expect(setPriority(staffCtx(await staffWithRole('product')), { number: f.tickets.aOrg.number, priority: 'p1', reason: 'Нельзя' })).rejects.toMatchObject({ code: 'forbidden' });
  // Событие записано, а транзакция после него сорвалась.
  await expect(
    withActor(f.l1.actor, async (tx) => {
      await emitEventTx(tx, { orgId: f.orgA.orgId, ticketId: f.tickets.aOrg.ticketId, kind: 'status_changed', payload: { from: 'new', to: 'in_progress' } });
      throw new Error('сбой после события');
    }),
  ).rejects.toThrow('сбой после события');
  expect(await allEvents()).toEqual([]);
  expect((await pools.root.query(`select count(*)::int as n from hdt_tickets`)).rows[0].n).toBe(before);
});

test('клиент событий не видит и не меняет; пишет только по своему обращению; сотрудник читает, но не меняет', async () => {
  const eventId = await seedEvent(f.tickets.aOrg, f.orgA.orgId);
  for (const member of [f.aUser, f.aAdmin, f.bUser]) {
    expect((await asActor(pools.app, member.actor, (c) => c.query(`select 1 from hdc_domain_events`))).rowCount).toBe(0);
    expect((await asActor(pools.app, member.actor, (c) => c.query(`update hdc_domain_events set processed_on = now()`))).rowCount).toBe(0);
    expect((await asActor(pools.app, member.actor, (c) => c.query(`delete from hdc_domain_events`))).rowCount).toBe(0);
  }
  const insert = (actor: Parameters<typeof asActor>[1], orgId: string, ticketId: string, extra = '') =>
    asActor(pools.app, actor, (c) =>
      c.query(`insert into hdc_domain_events (org_id, ticket_id, kind${extra ? ', ' + extra.split('=')[0] : ''}) values ($1, $2, 'client_replied'${extra ? ', ' + extra.split('=')[1] : ''})`, [orgId, ticketId]),
    );
  // Чужая организация, чужое личное обращение, "порождено правилом", уже разобранное: отказ.
  await expect(insert(f.aUser.actor, f.orgB.orgId, f.tickets.bOrg.ticketId)).rejects.toThrow(/row-level security/);
  await expect(insert(f.aUser.actor, f.orgA.orgId, f.tickets.aPrivate.ticketId)).rejects.toThrow(/row-level security/);
  await expect(insert(f.aUser.actor, f.orgA.orgId, f.tickets.aOrg.ticketId, 'is_by_rule=true')).rejects.toThrow(/row-level security/);
  await expect(insert(f.aUser.actor, f.orgA.orgId, f.tickets.aOrg.ticketId, 'processed_on=now()')).rejects.toThrow(/row-level security/);
  await expect(insert(f.l1.actor, f.orgA.orgId, f.tickets.aOrg.ticketId, 'processed_on=now()')).rejects.toThrow(/row-level security/);
  // Событие с организацией, не совпадающей с обращением, не принимается ни от кого.
  await expect(insert(f.l1.actor, f.orgB.orgId, f.tickets.aOrg.ticketId)).rejects.toThrow(/row-level security|hdc_domain_events_f1/);
  await insert(f.aUser.actor, f.orgA.orgId, f.tickets.aOrg.ticketId);
  // Роль product обращений не ведёт и событий не пишет.
  const product = await staffWithRole('product');
  await expect(insert(product.actor, f.orgA.orgId, f.tickets.aOrg.ticketId)).rejects.toThrow(/row-level security/);
  // Сотрудник читает события, но отметку разбора ставит и удаляет только система.
  for (const actor of [f.l1.actor, f.adminStaff.actor, product.actor]) {
    expect((await asActor(pools.app, actor, (c) => c.query(`select 1 from hdc_domain_events`))).rowCount).toBe(2);
    expect((await asActor(pools.app, actor, (c) => c.query(`update hdc_domain_events set processed_on = now()`))).rowCount).toBe(0);
    expect((await asActor(pools.app, actor, (c) => c.query(`delete from hdc_domain_events`))).rowCount).toBe(0);
  }
  expect((await asActor(pools.app, SYSTEM, (c) => c.query(`update hdc_domain_events set processed_on = now() where event_id = $1`, [eventId]))).rowCount).toBe(1);
});

test('разбор: события идут по порядку, отмечаются разобранными, повторный запуск ничего не делает', async () => {
  const ids = [];
  for (let i = 0; i < 5; i++) ids.push(await seedEvent(i % 2 ? f.tickets.aOrg : f.tickets.bOrg, i % 2 ? f.orgA.orgId : f.orgB.orgId, 'status_changed', { n: i }));
  const seen: DomainEvent[] = [];
  const result = await processEvents(SYSTEM, async (tx, event) => {
    // Обработчик работает в транзакции системы: видит обращение события.
    const found = await tx.execute(sql`select 1 from hdt_tickets where ticket_id = ${event.ticketId}`);
    expect(found.rows).toHaveLength(1);
    seen.push(event);
  });
  expect(result).toEqual({ processed: 5, failed: 0 });
  expect(seen.map((event) => event.eventId)).toEqual(ids);
  expect(seen[1]).toMatchObject({ orgId: f.orgA.orgId, ticketId: f.tickets.aOrg.ticketId, kind: 'status_changed', payload: { n: 1 }, isByRule: false });
  expect((await allEvents()).every((row) => row.processed_on !== null)).toBe(true);
  expect(await processEvents(SYSTEM, async () => expect.unreachable())).toEqual({ processed: 0, failed: 0 });
});

test('два разборщика одновременно не разбирают одно событие дважды', async () => {
  const tickets = [f.tickets.aOrg, f.tickets.aPrivate, f.tickets.aMine];
  for (let i = 0; i < 60; i++) await seedEvent(tickets[i % 3] ?? f.tickets.aOrg, f.orgA.orgId, 'status_changed', { n: i });
  const seen: string[] = [];
  const perTicket = new Map<string, number[]>();
  const handler = async (_tx: unknown, event: DomainEvent) => {
    await new Promise((resolve) => setTimeout(resolve, 2));
    seen.push(event.eventId);
    perTicket.set(event.ticketId, [...(perTicket.get(event.ticketId) ?? []), Number(event.payload.n)]);
  };
  const results = await Promise.all([processEvents(SYSTEM, handler, { batch: 7 }), processEvents(SYSTEM, handler, { batch: 7 }), processEvents(SYSTEM, handler, { batch: 7 })]);
  expect(results.reduce((sum, r) => sum + r.processed, 0)).toBe(60);
  expect(seen).toHaveLength(60);
  expect(new Set(seen).size).toBe(60);
  // События одного обращения разобраны в порядке записи, кто бы из разборщиков их ни взял.
  for (const order of perTicket.values()) expect(order).toEqual([...order].sort((a, b) => a - b));
  expect((await allEvents()).every((row) => row.processed_on !== null && row.attempts === 0)).toBe(true);
});

test('остановка процесса: разбор прекращается между событиями, нетронутые остаются в очереди', async () => {
  for (let i = 0; i < 10; i++) await seedEvent(f.tickets.aOrg, f.orgA.orgId, 'status_changed', { n: i });
  let handled = 0;
  const first = await processEvents(SYSTEM, async () => void handled++, { batch: 4, stopped: () => handled >= 3 });
  expect(first).toEqual({ processed: 3, failed: 0 });
  const left = (await allEvents()).filter((row) => row.processed_on === null);
  expect(left.map((row) => row.payload.n)).toEqual([3, 4, 5, 6, 7, 8, 9]);
  expect(left.every((row) => row.attempts === 0)).toBe(true);
  // Следующий запуск берёт оставшиеся; бюджет времени останавливает так же, как остановка процесса.
  let calls = 0;
  expect(await processEvents(SYSTEM, async () => undefined, { budgetMs: 5, clock: () => (calls++ === 0 ? 0 : 10) })).toEqual({ processed: 0, failed: 0 });
  expect(await processEvents(SYSTEM, async () => undefined)).toEqual({ processed: 7, failed: 0 });
});

test('сбой обработчика: событие остаётся, следующие события того же обращения ждут, после пяти попыток событие снимается', async () => {
  const bad = await seedEvent(f.tickets.aOrg, f.orgA.orgId, 'status_changed', { n: 0 });
  const blocked = await seedEvent(f.tickets.aOrg, f.orgA.orgId, 'status_changed', { n: 1 });
  const other = await seedEvent(f.tickets.bOrg, f.orgB.orgId, 'status_changed', { n: 2 });
  const handler = async (tx: Parameters<Parameters<typeof processEvents>[1]>[0], event: DomainEvent) => {
    if (event.eventId !== bad) return;
    // Запись обработчика до сбоя откатывается вместе с его транзакцией.
    await tx.execute(sql`update hdt_tickets set title = 'Испорчено' where ticket_id = ${event.ticketId}`);
    throw new Error('правило сломалось: секретный текст');
  };
  // Часы разбора подменены: между попытками проходит пауза перед повтором (10 секунд, 1, 5 и 15 минут).
  let at = Date.now();
  const attempt = () => processEvents(SYSTEM, handler, { clock: () => at });
  expect(await attempt()).toEqual({ processed: 1, failed: 1 });
  const byId = async () => new Map((await allEvents()).map((row) => [row.event_id, row]));
  let rows = await byId();
  expect(rows.get(bad)).toMatchObject({ processed_on: null, attempts: 1, last_error: 'Error' });
  expect(rows.get(blocked)).toMatchObject({ processed_on: null, attempts: 0 });
  expect(rows.get(other)?.processed_on).not.toBeNull();
  expect((await pools.root.query(`select title from hdt_tickets where ticket_id = $1`, [f.tickets.aOrg.ticketId])).rows[0].title).toBe(f.tickets.aOrg.title);
  // Раньше срока повтора событие не берётся и попытка не тратится: повторные пробуждения задачи событие не снимают.
  expect(await attempt()).toEqual({ processed: 0, failed: 0 });
  expect((await byId()).get(bad)).toMatchObject({ processed_on: null, attempts: 1 });
  for (let n = 2; n < EVENT_MAX_ATTEMPTS; n++) {
    at += 16 * MINUTE;
    expect(await attempt()).toEqual({ processed: 0, failed: 1 });
  }
  // Последняя попытка: событие снимается с разбора с отметкой ошибки, следующее событие обращения проходит.
  at += 16 * MINUTE;
  expect(await attempt()).toEqual({ processed: 1, failed: 1 });
  rows = await byId();
  expect(rows.get(bad)).toMatchObject({ attempts: EVENT_MAX_ATTEMPTS, last_error: 'Error' });
  expect(rows.get(bad)?.processed_on).not.toBeNull();
  expect(rows.get(blocked)?.processed_on).not.toBeNull();
});

test('срок нарушен: sla_breached там, где ставится отметка нарушения, один раз на срок', async () => {
  const t = f.tickets.aOrg;
  await setPriority(staffCtx(f.l1), { number: t.number, priority: 'p1', reason: 'Стоит склад' });
  await clear();
  const due = (await pools.root.query(`select first_response_due_on, resolution_due_on from hdt_tickets where ticket_id = $1`, [t.ticketId])).rows[0];
  const afterFirst = new Date(due.first_response_due_on.getTime() + MINUTE);
  await ticketsMinute(MINUTE_JOB, afterFirst);
  await ticketsMinute(MINUTE_JOB, afterFirst);
  expect(brief(await eventsOf(t.ticketId))).toEqual([['sla_breached', { deadline: 'first_response' }]]);
  const afterResolution = new Date(due.resolution_due_on.getTime() + MINUTE);
  await ticketsMinute(MINUTE_JOB, afterResolution);
  await ticketsMinute(MINUTE_JOB, afterResolution);
  expect(brief(await eventsOf(t.ticketId))).toEqual([
    ['sla_breached', { deadline: 'first_response' }],
    ['sla_breached', { deadline: 'resolution' }],
  ]);
});

test('срок скоро: sla_soon один раз на срок и снова после того, как срок сдвинулся', async () => {
  const t = f.tickets.aOrg;
  const l1 = staffCtx(f.l1);
  // P4: срок первого ответа 8 рабочих часов, решение 5 рабочих дней.
  await setPriority(l1, { number: t.number, priority: 'p4', reason: 'Вопрос' });
  await clear();
  const read = () =>
    pools.root
      .query(`select created_on, first_response_due_on, resolution_due_on, first_response_soon_on, resolution_soon_on from hdt_tickets where ticket_id = $1`, [t.ticketId])
      .then((r) => r.rows[0] as Record<string, Date | null>);
  let row = await read();
  if (!row.first_response_due_on || !row.first_response_soon_on || !row.resolution_soon_on || !row.resolution_due_on) throw new Error('сроки не посчитаны');
  // Порог: срок близко, когда осталось меньше 20% рабочего времени.
  expect(row.first_response_soon_on.getTime()).toBeLessThan(row.first_response_due_on.getTime());
  expect(row.first_response_soon_on.getTime()).toBeGreaterThan((row.created_on as Date).getTime());

  // До порога событий нет.
  await ticketsMinute(MINUTE_JOB, new Date(row.first_response_soon_on.getTime() - 5 * MINUTE));
  expect(await eventsOf(t.ticketId)).toEqual([]);
  const soonFirst = new Date(row.first_response_soon_on.getTime() + 2 * MINUTE);
  await ticketsMinute(MINUTE_JOB, soonFirst);
  await ticketsMinute(MINUTE_JOB, new Date(soonFirst.getTime() + MINUTE));
  expect(brief(await eventsOf(t.ticketId))).toEqual([['sla_soon', { deadline: 'first_response' }]]);
  expect((await read()).first_response_soon_on).toBeNull();

  // Срок решения: свой порог и своё событие.
  const soonResolution = new Date(row.resolution_soon_on.getTime() + 2 * MINUTE);
  await pools.root.query(`update hdt_tickets set first_responded_on = now() where ticket_id = $1`, [t.ticketId]);
  await ticketsMinute(MINUTE_JOB, soonResolution);
  await ticketsMinute(MINUTE_JOB, new Date(soonResolution.getTime() + MINUTE));
  expect(brief(await eventsOf(t.ticketId)).filter(([kind]) => kind === 'sla_soon')).toEqual([
    ['sla_soon', { deadline: 'first_response' }],
    ['sla_soon', { deadline: 'resolution' }],
  ]);

  // Срок сдвинулся (смена приоритета): порог взведён заново, событие приходит ещё раз.
  await clear();
  await setPriority(l1, { number: t.number, priority: 'p3', reason: 'Важнее' });
  row = await read();
  if (!row.resolution_soon_on) throw new Error('порог не взведён заново');
  await clear();
  await ticketsMinute(MINUTE_JOB, new Date(row.resolution_soon_on.getTime() + 2 * MINUTE));
  expect(brief(await eventsOf(t.ticketId)).filter(([kind]) => kind === 'sla_soon')).toEqual([['sla_soon', { deadline: 'resolution' }]]);
});

test('срок скоро не приходит по решённому, по обращению на паузе и после первого ответа', async () => {
  const l1 = staffCtx(f.l1);
  const far = new Date(Date.now() + 365 * 86_400_000);
  // Первый ответ дан до порога: события о сроке первого ответа нет.
  await staffReply(l1, f.tickets.aOrg.number);
  // Решённое: пороги сняты пересчётом сроков.
  await takeTicket(l1, f.tickets.aMine.number);
  await setStatus(l1, { number: f.tickets.aMine.number, to: 'resolved', resolution: 'solved' });
  expect((await pools.root.query(`select first_response_soon_on, resolution_soon_on from hdt_tickets where ticket_id = $1`, [f.tickets.aMine.ticketId])).rows[0]).toEqual({
    first_response_soon_on: null,
    resolution_soon_on: null,
  });
  // На паузе срок решения стоит: событие не приходит, порог ждёт выхода из паузы.
  await staffReply(l1, f.tickets.bOrg.number, { waitForClient: true });
  await clear();
  await pools.root.query(`update hdt_tickets set first_response_soon_on = now() - interval '1 hour', resolution_soon_on = now() - interval '1 hour', first_response_due_on = $1, resolution_due_on = $1
                           where ticket_id = any($2)`, [far, [f.tickets.aOrg.ticketId, f.tickets.bOrg.ticketId]]);
  await ticketsMinute(MINUTE_JOB, new Date());
  const soon = (await allEvents()).filter((row) => row.kind === 'sla_soon');
  expect(soon.filter((row) => row.payload.deadline === 'first_response')).toEqual([]);
  expect(soon.filter((row) => row.ticket_id === f.tickets.bOrg.ticketId)).toEqual([]);
  expect((await pools.root.query(`select resolution_soon_on from hdt_tickets where ticket_id = $1`, [f.tickets.bOrg.ticketId])).rows[0].resolution_soon_on).not.toBeNull();
});

test('ночная очистка удаляет разобранные события старше 30 суток', async () => {
  const old = await seedEvent(f.tickets.aOrg, f.orgA.orgId);
  const fresh = await seedEvent(f.tickets.aOrg, f.orgA.orgId);
  const pending = await seedEvent(f.tickets.aOrg, f.orgA.orgId);
  await pools.root.query(`update hdc_domain_events set processed_on = now() - interval '31 days', created_on = now() - interval '40 days' where event_id = $1`, [old]);
  await pools.root.query(`update hdc_domain_events set processed_on = now() - interval '29 days' where event_id = $1`, [fresh]);
  await pools.root.query(`update hdc_domain_events set created_on = now() - interval '90 days' where event_id = $1`, [pending]);
  expect(await cleanupDomainEvents(SYSTEM)).toBe(1);
  expect((await allEvents()).map((row) => row.event_id).sort()).toEqual([fresh, pending].sort());
});

test('очередь разбора идёт по частичному индексу неразобранных событий', async () => {
  const indexes = Object.fromEntries(
    (await pools.root.query(`select indexname, indexdef from pg_indexes where tablename = 'hdc_domain_events'`)).rows.map((r) => [r.indexname, r.indexdef as string]),
  ) as Record<string, string>;
  expect(indexes.hdc_domain_events_i1).toMatch(/\(event_id\) WHERE \(processed_on IS NULL\)/);
  expect(indexes.hdc_domain_events_i2).toMatch(/\(ticket_id, event_id\)/);
  // На большой очереди с малым числом ждущих событий запрос кандидатов берёт этот индекс, а не всю таблицу.
  await pools.root.query(
    `insert into hdc_domain_events (org_id, ticket_id, kind, processed_on)
     select $1, $2, 'status_changed', case when g % 1000 = 0 then null else now() end from generate_series(1, 20000) g`,
    [f.orgA.orgId, f.tickets.aOrg.ticketId],
  );
  await pools.root.query(`analyze hdc_domain_events`);
  const { captureQueries, plansFor } = await import('./helpers/bulk');
  const { result, queries } = await captureQueries(() => processEvents(SYSTEM, async () => undefined));
  expect(result).toEqual({ processed: 20, failed: 0 });
  const plans = await plansFor(SYSTEM, queries.filter((query) => /^\s*select/i.test(query.text)), 'hdc_domain_events');
  expect(plans.length).toBeGreaterThan(0);
  for (const plan of plans) expect(plan, plan).not.toMatch(/Seq Scan on hdc_domain_events/);
});

test('задача automation.process зарегистрирована: очередь, расписание раз в минуту', () => {
  expect(JOB_NAMES).toContain('automation.process');
  expect(QUEUES).toHaveProperty('automation.process');
  expect(SCHEDULES).toContainEqual({ name: 'automation.process', cron: '* * * * *', tz: 'UTC' });
});
