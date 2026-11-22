import { expect, test } from 'vitest';
import { listThanks, replyToTicket, setPriority, snoozeTicket, ticketsMinute } from '@/modules/hdt/api';
import { addWorkingDays, TASHKENT_DEFAULT } from '@/modules/hdt/sla';
import { clientCtx, staffCtx } from './helpers/auth';
import { pools } from './helpers/db';
import { seedTwoOrgs } from './isolation/fixture';

// Задача раз в минуту (решения 2, 8, 13, 14 плана M3; FR-TK-10, FR-TK-15, 10.5) и благодарность (FR-TK-14, решение 15).

const SYSTEM = { type: 'system', job: 'tickets.minute' } as const;
const MINUTE = 60_000;
const row = (ticketId: string) =>
  pools.root
    .query(
      `select status, closed_on, snoozed_until, first_response_due_on, resolution_due_on, first_response_breached_on, resolution_breached_on
         from hdt_tickets where ticket_id = $1`,
      [ticketId],
    )
    .then((r) => r.rows[0]);
const events = (ticketId: string, kind: string) =>
  pools.root.query(`select payload, is_internal from hdt_ticket_events where ticket_id = $1 and kind = $2 order by created_on, event_id`, [ticketId, kind]).then((r) => r.rows);
const systemMessages = (ticketId: string) =>
  pools.root.query(`select body, is_internal from hdt_ticket_messages where ticket_id = $1 and author_type = 'system'`, [ticketId]).then((r) => r.rows);
/** Состояние обращения в обход сервиса: даты решения и паузы в прошлом. */
const setState = (ticketId: string, sql: string, params: unknown[] = []) => pools.root.query(`update hdt_tickets set ${sql} where ticket_id = $1`, [ticketId, ...params]);

test('нарушение отмечается один раз, повторный запуск событий не дублирует', async () => {
  const f = await seedTwoOrgs();
  const t = f.tickets.aOrg;
  await setPriority(staffCtx(f.l1), { number: t.number, priority: 'p1', reason: 'Стоит склад' });
  const due = await row(t.ticketId);
  const afterFirst = new Date(due.first_response_due_on.getTime() + MINUTE);
  expect((await ticketsMinute(SYSTEM, afterFirst)).breached).toBeGreaterThanOrEqual(1);
  await ticketsMinute(SYSTEM, afterFirst);
  expect((await events(t.ticketId, 'due')).map((e) => [e.payload, e.is_internal])).toEqual([[{ kind: 'first_response' }, true]]);
  expect((await row(t.ticketId)).first_response_breached_on?.toISOString()).toBe(afterFirst.toISOString());
  const afterResolution = new Date(due.resolution_due_on.getTime() + MINUTE);
  await ticketsMinute(SYSTEM, afterResolution);
  await ticketsMinute(SYSTEM, afterResolution);
  expect((await events(t.ticketId, 'due')).map((e) => e.payload)).toEqual([{ kind: 'first_response' }, { kind: 'resolution' }]);
  // На паузе ("Ждём вашего ответа") срок решения не нарушается.
  const waiting = f.tickets.aMine;
  await setPriority(staffCtx(f.l1), { number: waiting.number, priority: 'p1', reason: 'Стоит склад' });
  await setState(waiting.ticketId, `status = 'waiting_customer', sla_paused_on = now()`);
  await ticketsMinute(SYSTEM, new Date((await row(waiting.ticketId)).resolution_due_on.getTime() + MINUTE));
  expect((await row(waiting.ticketId)).resolution_breached_on).toBeNull();
});

test('процесс стоял час: нарушения и автозакрытия догнаны', async () => {
  const f = await seedTwoOrgs();
  const breached = f.tickets.aOrg;
  await setPriority(staffCtx(f.l1), { number: breached.number, priority: 'p1', reason: 'Стоит склад' });
  await setState(breached.ticketId, `first_response_due_on = now() - interval '1 hour', resolution_due_on = now() - interval '30 minutes'`);
  const resolved = f.tickets.aMine;
  await setState(resolved.ticketId, `status = 'resolved', resolved_on = now() - interval '20 days', resolution_type = 'solved'`);
  const result = await ticketsMinute(SYSTEM, new Date());
  expect(result.breached).toBeGreaterThanOrEqual(2);
  expect(result.closed).toBeGreaterThanOrEqual(1);
  expect((await events(breached.ticketId, 'due')).map((e) => e.payload.kind)).toEqual(['first_response', 'resolution']);
  expect((await row(resolved.ticketId)).status).toBe('closed');
});

test('решённое закрывается через 5 рабочих дней, ждущее клиента через 7 с сообщением', async () => {
  const f = await seedTwoOrgs();
  // Понедельник 10:00 по Ташкенту.
  const start = new Date('2026-11-02T05:00:00Z');
  const resolved = f.tickets.aOrg;
  await setState(resolved.ticketId, `status = 'resolved', resolved_on = $2, resolution_type = 'solved'`, [start]);
  const closeAt = addWorkingDays(start, 5, TASHKENT_DEFAULT);
  await ticketsMinute(SYSTEM, new Date(closeAt.getTime() - MINUTE));
  expect((await row(resolved.ticketId)).status).toBe('resolved');
  await ticketsMinute(SYSTEM, new Date(closeAt.getTime() + MINUTE));
  expect((await row(resolved.ticketId)).status).toBe('closed');
  expect((await row(resolved.ticketId)).closed_on).not.toBeNull();
  expect((await events(resolved.ticketId, 'status')).map((e) => [e.payload, e.is_internal])).toEqual([[{ from: 'resolved', to: 'closed' }, false]]);
  expect(await systemMessages(resolved.ticketId)).toEqual([{ body: expect.stringContaining('5 рабочих дней'), is_internal: false }]);

  const waiting = f.tickets.aMine;
  await setState(waiting.ticketId, `status = 'waiting_customer', sla_paused_on = $2`, [start]);
  const waitAt = addWorkingDays(start, 7, TASHKENT_DEFAULT);
  await ticketsMinute(SYSTEM, new Date(waitAt.getTime() - MINUTE));
  expect((await row(waiting.ticketId)).status).toBe('waiting_customer');
  await ticketsMinute(SYSTEM, new Date(waitAt.getTime() + MINUTE));
  expect((await row(waiting.ticketId)).status).toBe('closed');
  expect(await systemMessages(waiting.ticketId)).toEqual([{ body: expect.stringContaining('7 рабочих дней'), is_internal: false }]);
  // Повторный запуск ничего не дублирует.
  await ticketsMinute(SYSTEM, new Date(waitAt.getTime() + 2 * MINUTE));
  expect(await systemMessages(waiting.ticketId)).toHaveLength(1);
});

test('сообщение клиента за минуту до автозакрытия: обращение не закрывается', async () => {
  const f = await seedTwoOrgs();
  const start = new Date('2026-11-02T05:00:00Z');
  const t = f.tickets.aOrg;
  await setState(t.ticketId, `status = 'waiting_customer', sla_paused_on = $2`, [start]);
  await replyToTicket(await clientCtx(f.aUser), { number: t.number, body: 'Вот снимок экрана, ошибка та же' });
  await ticketsMinute(SYSTEM, new Date(addWorkingDays(start, 7, TASHKENT_DEFAULT).getTime() + MINUTE));
  expect((await row(t.ticketId)).status).toBe('in_progress');
  expect(await systemMessages(t.ticketId)).toEqual([]);
});

test('отложенное возвращается в очередь в своё время', async () => {
  const f = await seedTwoOrgs();
  const t = f.tickets.aOrg;
  const until = new Date(Date.now() + 60 * MINUTE);
  await snoozeTicket(staffCtx(f.l1), { number: t.number, until: until.toISOString() });
  expect((await ticketsMinute(SYSTEM, new Date())).unsnoozed).toBe(0);
  expect((await row(t.ticketId)).snoozed_until).not.toBeNull();
  expect((await ticketsMinute(SYSTEM, new Date(until.getTime() + MINUTE))).unsnoozed).toBe(1);
  expect((await row(t.ticketId)).snoozed_until).toBeNull();
  expect((await events(t.ticketId, 'snooze')).map((e) => e.payload)).toEqual([{ until: until.toISOString() }, { until: null, returned: true }]);
});

test('присутствие старше минуты удалено', async () => {
  const f = await seedTwoOrgs();
  await pools.root.query(
    `insert into hdt_ticket_presence (ticket_id, user_id, mode, expires_on) values ($1, $2, 'viewing', now() - interval '1 second'), ($1, $3, 'typing', now() + interval '1 minute')`,
    [f.tickets.aOrg.ticketId, f.l1.userId, f.care.userId],
  );
  expect((await ticketsMinute(SYSTEM, new Date())).presenceRemoved).toBe(1);
  expect((await pools.root.query(`select user_id from hdt_ticket_presence`)).rows).toEqual([{ user_id: f.care.userId }]);
});

test('благодарность не открывает решённое и видна в списке "Не открыли обращение"', async () => {
  const f = await seedTwoOrgs();
  const t = f.tickets.aOrg;
  await setState(t.ticketId, `status = 'resolved', resolved_on = now(), resolution_type = 'solved'`);
  const client = await clientCtx(f.aUser);
  await replyToTicket(client, { number: t.number, body: 'Спасибо, всё работает!' });
  expect((await row(t.ticketId)).status).toBe('resolved');
  const list = await listThanks(staffCtx(f.l1), {});
  expect(list.items.map((x) => [x.number, x.body])).toEqual([[t.number, 'Спасибо, всё работает!']]);
  // Новый вопрос открывает обращение заново.
  await replyToTicket(client, { number: t.number, body: 'Спасибо, но отчёт за прошлый месяц всё ещё пустой' });
  expect((await row(t.ticketId)).status).toBe('in_progress');
  expect((await listThanks(staffCtx(f.l1), {})).items).toHaveLength(1);
});

test('срок автозакрытия из настроек: текст клиенту называет заданное число рабочих дней', async () => {
  const f = await seedTwoOrgs();
  await pools.root.query(`insert into hdc_settings (code, value) values ('tickets.autoclose_resolved_days', '3') on conflict (code) do update set value = '3'`);
  const start = new Date('2026-11-02T05:00:00Z');
  const t = f.tickets.aOrg;
  await setState(t.ticketId, `status = 'resolved', resolved_on = $2, resolution_type = 'solved'`, [start]);
  await ticketsMinute(SYSTEM, new Date(addWorkingDays(start, 3, TASHKENT_DEFAULT).getTime() + MINUTE));
  expect((await row(t.ticketId)).status).toBe('closed');
  expect(await systemMessages(t.ticketId)).toEqual([{ body: expect.stringContaining('3 рабочих дня'), is_internal: false }]);
});
