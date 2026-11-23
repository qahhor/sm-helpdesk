import { beforeEach, expect, test } from 'vitest';
import { savePrefs } from '@/modules/hdn/api/notifications';
import { createTicket, getAgentTicket, mergeTicket, postStaffMessage, replyToTicket, setStatus, ticketsMinute } from '@/modules/hdt/api';
import { clientCtx, staffCtx } from './helpers/auth';
import { pools } from './helpers/db';
import { type Fixture, seedTwoOrgs } from './isolation/fixture';

// Письма и уведомления клиенту по событиям обращения (FR-NT-01, FR-NT-04, FR-NT-09, FR-NT-10, FR-TK-15;
// решения 6 и 24 вехи M4). Письмо ставится строкой очереди в транзакции действия.

const SYSTEM = { type: 'system', job: 'tickets.minute' } as const;
let f: Fixture;
beforeEach(async () => {
  f = await seedTwoOrgs();
});

type Mail = { template: string; recipient_user_id: string; payload: Record<string, unknown>; settings_path: string | null };
const mails = (ticketId: string) =>
  pools.root
    .query<Mail>(`select template, recipient_user_id, payload, settings_path from hdn_outbox where ticket_id = $1 and status = 'queued' order by created_on, outbox_id`, [ticketId])
    .then((r) => r.rows);
const notices = (ticketId: string) =>
  pools.root
    .query<{ user_id: string; kind: string }>(`select user_id, kind from hdn_notifications where ticket_id = $1 and payload ? 'title' order by created_on, notification_id`, [ticketId])
    .then((r) => r.rows);
const ticketIdOf = (number: number) => pools.root.query(`select ticket_id from hdt_tickets where number = $1`, [number]).then((r) => r.rows[0].ticket_id as string);
const versionOf = async (number: number) => (await getAgentTicket(staffCtx(f.l1), number))?.version ?? '';
const reply = async (number: number, body: string, waitForClient = false) =>
  postStaffMessage(staffCtx(f.l1), { number, body, internal: false, waitForClient, seenVersion: await versionOf(number) });
const setState = (ticketId: string, sql: string, params: unknown[] = []) => pools.root.query(`update hdt_tickets set ${sql} where ticket_id = $1`, [ticketId, ...params]);
const setSetting = (code: string, value: unknown) =>
  pools.root.query(`insert into hdc_settings (code, value) values ($1, $2)`, [code, JSON.stringify(value)]);

test('клиент создал обращение: автору письмо с номером и уведомление', async () => {
  const { number } = await createTicket(await clientCtx(f.aUser), { description: 'Не печатается накладная', type: 'bug', impact: 'minor', locale: 'ru' });
  const ticketId = await ticketIdOf(number);
  expect(await mails(ticketId)).toEqual([
    {
      template: 'ticket_created',
      recipient_user_id: f.aUser.userId,
      payload: { template: 'ticket_created', number, title: 'Не печатается накладная', url: `/tickets/SUP-${number}`, viaEmail: false },
      settings_path: null,
    },
  ]);
  expect(await notices(ticketId)).toEqual([{ user_id: f.aUser.userId, kind: 'ticket_created' }]);
});

test('ответ сотрудника с "Ждём ответа клиента": одно письмо, а не два', async () => {
  const t = f.tickets.aOrg;
  await reply(t.number, 'Пришлите, пожалуйста, снимок экрана.', true);
  const sent = await mails(t.ticketId);
  expect(sent.map((m) => [m.template, m.recipient_user_id])).toEqual([['ticket_reply', f.aUser.userId]]);
  expect(sent[0]!.payload).toMatchObject({ number: t.number, body: 'Пришлите, пожалуйста, снимок экрана.', url: `/tickets/SUP-${t.number}` });
  expect(await notices(t.ticketId)).toEqual([{ user_id: f.aUser.userId, kind: 'ticket_reply' }]);
});

test('заметка сотрудника писем и уведомлений клиенту не даёт', async () => {
  const t = f.tickets.aOrg;
  await postStaffMessage(staffCtx(f.l1), { number: t.number, body: 'Внутреннее: проверить логи', internal: true, seenVersion: await versionOf(t.number) });
  expect(await mails(t.ticketId)).toEqual([]);
  expect(await notices(t.ticketId)).toEqual([]);
});

test('наблюдатель с выключенными письмами получает только уведомление в портале', async () => {
  const t = f.tickets.aOrg;
  await pools.root.query(`insert into hdt_ticket_watchers (org_id, ticket_id, user_id, source) values ($1, $2, $3, 'manual')`, [f.orgA.orgId, t.ticketId, f.aAdmin.userId]);
  await savePrefs(f.aAdmin.actor, { own: { email: true, telegram: true }, watched: { email: false, telegram: true } });
  await reply(t.number, 'Исправили настройку печати.');
  expect((await mails(t.ticketId)).map((m) => m.recipient_user_id)).toEqual([f.aUser.userId]);
  expect((await notices(t.ticketId)).map((n) => n.user_id).sort()).toEqual([f.aUser.userId, f.aAdmin.userId].sort());
  // Включённые письма наблюдателю отключаются ссылкой из письма.
  await savePrefs(f.aAdmin.actor, { own: { email: true, telegram: true }, watched: { email: true, telegram: true } });
  await reply(t.number, 'И ещё одно.');
  const watcherMail = (await mails(t.ticketId)).find((m) => m.recipient_user_id === f.aAdmin.userId);
  expect(watcherMail?.settings_path).toBe('/settings');
});

test('переход "Новое" в "В работе" письма не даёт, "В разработке" даёт', async () => {
  const t = f.tickets.aOrg;
  await setStatus(staffCtx(f.care), { number: t.number, to: 'in_progress' });
  expect(await mails(t.ticketId)).toEqual([]);
  await setStatus(staffCtx(f.care), { number: t.number, to: 'in_development' });
  const sent = await mails(t.ticketId);
  expect(sent.map((m) => m.template)).toEqual(['ticket_status']);
  expect(sent[0]!.payload).toMatchObject({ status: 'in_development', number: t.number });
  expect(await notices(t.ticketId)).toEqual([{ user_id: f.aUser.userId, kind: 'ticket_status' }]);
});

test('решено: письмо с просьбой оценить', async () => {
  const t = f.tickets.aOrg;
  await setStatus(staffCtx(f.l1), { number: t.number, to: 'in_progress' });
  await setStatus(staffCtx(f.l1), { number: t.number, to: 'resolved', resolution: 'solved' });
  const sent = await mails(t.ticketId);
  expect(sent.map((m) => m.template)).toEqual(['ticket_resolved']);
  expect(sent[0]!.payload).toMatchObject({ number: t.number, url: `/tickets/SUP-${t.number}` });
});

test('объединение и автозакрытие: письмо о закрытии', async () => {
  const dup = f.tickets.aMine;
  await mergeTicket(staffCtx(f.l1), { number: dup.number, intoNumber: f.tickets.aOrg.number });
  expect((await mails(dup.ticketId)).map((m) => [m.template, m.payload.status, m.payload.mergedInto])).toEqual([['ticket_status', 'closed', f.tickets.aOrg.number]]);
  const resolved = f.tickets.aOrg;
  await setState(resolved.ticketId, `status = 'resolved', resolved_on = now() - interval '20 days', resolution_type = 'solved'`);
  await ticketsMinute(SYSTEM, new Date());
  const closed = (await mails(resolved.ticketId)).filter((m) => m.template === 'ticket_status');
  expect(closed.map((m) => [m.payload.status, m.payload.auto])).toEqual([['closed', true]]);
});

// Среда 25.11.2026 12:00 по Ташкенту; ожидание началось в пятницу 20.11 в 12:00: прошло 3 рабочих дня (сб, пн, вт).
const WEDNESDAY = new Date('2026-11-25T07:00:00Z');
const FRIDAY = new Date('2026-11-20T07:00:00Z');

test('напоминание через 3 рабочих дня ожидания, один раз, повторный запуск не дублирует', async () => {
  const t = f.tickets.aOrg;
  await setState(t.ticketId, `status = 'waiting_customer', sla_paused_on = $2, last_client_message_on = null`, [FRIDAY]);
  await ticketsMinute(SYSTEM, WEDNESDAY);
  await ticketsMinute(SYSTEM, new Date(WEDNESDAY.getTime() + 60_000));
  const reminders = (await mails(t.ticketId)).filter((m) => m.template === 'waiting_reminder');
  expect(reminders.map((m) => m.recipient_user_id)).toEqual([f.aUser.userId]);
  expect(reminders[0]!.payload).toMatchObject({ number: t.number, closeInDays: 4 });
  expect((await notices(t.ticketId)).map((n) => n.kind)).toEqual(['waiting_reminder']);
  // Новый период ожидания: напоминание снова возможно.
  const row = await pools.root.query(`select waiting_reminded_on from hdt_tickets where ticket_id = $1`, [t.ticketId]);
  expect(row.rows[0].waiting_reminded_on).not.toBeNull();
});

test('напоминание и автозакрытие идут по сроку из настроек, если он задан', async () => {
  await setSetting('notify.waiting_reminder_days', 5);
  const t = f.tickets.aOrg;
  await setState(t.ticketId, `status = 'waiting_customer', sla_paused_on = $2, last_client_message_on = null`, [FRIDAY]);
  await ticketsMinute(SYSTEM, WEDNESDAY);
  expect((await mails(t.ticketId)).filter((m) => m.template === 'waiting_reminder')).toEqual([]);
  // Автозакрытие ждущего клиента через 2 рабочих дня вместо 7.
  await setSetting('tickets.autoclose_waiting_days', 2);
  await ticketsMinute(SYSTEM, WEDNESDAY);
  expect((await pools.root.query(`select status from hdt_tickets where ticket_id = $1`, [t.ticketId])).rows[0].status).toBe('closed');
  // Решённое через 1 рабочий день вместо 5.
  await setSetting('tickets.autoclose_resolved_days', 1);
  const r = f.tickets.aMine;
  await setState(r.ticketId, `status = 'resolved', resolved_on = $2, resolution_type = 'solved'`, [FRIDAY]);
  await ticketsMinute(SYSTEM, WEDNESDAY);
  expect((await pools.root.query(`select status from hdt_tickets where ticket_id = $1`, [r.ticketId])).rows[0].status).toBe('closed');
});

test('ответ клиента: исполнителю уведомление в портале', async () => {
  const t = f.tickets.aOrg;
  await setState(t.ticketId, `assignee_id = $2, status = 'in_progress'`, [f.l1.userId]);
  await replyToTicket(await clientCtx(f.aUser), { number: t.number, body: 'Вот снимок экрана' });
  expect(await notices(t.ticketId)).toEqual([{ user_id: f.l1.userId, kind: 'client_replied' }]);
  expect(await mails(t.ticketId)).toEqual([]);
});
