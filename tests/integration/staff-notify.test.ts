import { afterEach, beforeEach, expect, test } from 'vitest';
import { savePrefs } from '@/modules/hdn/api/notifications';
import { saveOncallBotToken, setOncallBotFactoryForTests } from '@/modules/hdn/api/oncall';
import { dispatchOutbox } from '@/modules/hdn/api/outbox';
import { createMemoryEmailProvider } from '@/modules/hdn/testing';
import { saveHolidays } from '@/modules/hdr/api';
import { createTicket, getAgentTicket, postStaffMessage, setPriority, setStatus, ticketsMinute } from '@/modules/hdt/api';
import { addWorkingDays, TASHKENT_DEFAULT } from '@/modules/hdt/sla';
import { clientCtx, staffCtx } from './helpers/auth';
import { asActor, pools } from './helpers/db';
import { type Fixture, seedTwoOrgs } from './isolation/fixture';

// Уведомления сотрудникам и сообщение дежурным о P1 (FR-AG-16, FR-SLA-06, 07, 09, 12; решения 7 и 8 вехи M4).

const SYSTEM = { type: 'system', job: 'tickets.minute' } as const;
const DISPATCH = { type: 'system', job: 'outbox.dispatch' } as const;
const MINUTE = 60_000;
let f: Fixture;
beforeEach(async () => {
  f = await seedTwoOrgs();
});
afterEach(() => setOncallBotFactoryForTests(null));

type Row = { template: string; channel: string; recipient_kind: string; recipient_user_id: string | null; payload: Record<string, unknown>; settings_path: string | null };
const outbox = (ticketId: string | null, template: string) =>
  pools.root
    .query<Row>(
      `select template, channel, recipient_kind, recipient_user_id, payload, settings_path from hdn_outbox
        where ($1::uuid is null or ticket_id = $1) and template = $2 and status = 'queued' order by created_on, outbox_id`,
      [ticketId, template],
    )
    .then((r) => r.rows);
const notices = (userId: string, kind: string, ticketId?: string) =>
  pools.root
    .query(`select ticket_id, payload from hdn_notifications where user_id = $1 and kind = $2 and ($3::uuid is null or ticket_id = $3) order by created_on`, [
      userId,
      kind,
      ticketId ?? null,
    ])
    .then((r) => r.rows);
const setState = (ticketId: string, sql: string, params: unknown[] = []) => pools.root.query(`update hdt_tickets set ${sql} where ticket_id = $1`, [ticketId, ...params]);
const setSetting = (code: string, value: unknown) => pools.root.query(`insert into hdc_settings (code, value) values ($1, $2)`, [code, JSON.stringify(value)]);
const versionOf = async (number: number) => (await getAgentTicket(staffCtx(f.l1), number))?.version ?? '';

test('упоминание: коллеге уведомление и письмо, при выключенной настройке только уведомление', async () => {
  const t = f.tickets.aOrg;
  await postStaffMessage(staffCtx(f.care), { number: t.number, body: '@Азиз посмотри логи', internal: true, seenVersion: await versionOf(t.number) });
  expect((await notices(f.l1.userId, 'mention')).map((n) => n.ticket_id)).toEqual([t.ticketId]);
  const mails = await outbox(t.ticketId, 'staff_mention');
  expect(mails.map((m) => [m.recipient_user_id, m.settings_path])).toEqual([[f.l1.userId, '/agent/account']]);
  expect(mails[0]!.payload).toMatchObject({ number: t.number, url: `/agent/tickets/SUP-${t.number}` });
  await savePrefs(f.l1.actor, { staffMention: false, staffBreach: true });
  await postStaffMessage(staffCtx(f.care), { number: t.number, body: '@Азиз и ещё', internal: true, seenVersion: await versionOf(t.number) });
  expect(await notices(f.l1.userId, 'mention')).toHaveLength(2);
  expect(await outbox(t.ticketId, 'staff_mention')).toHaveLength(1);
});

test('нарушение срока: руководителю линии один раз', async () => {
  await pools.root.query(`update hdu_staff set is_lead = true where user_id = $1`, [f.l1.userId]);
  const t = f.tickets.aOrg;
  await setPriority(staffCtx(f.care), { number: t.number, priority: 'p2', reason: 'Проверка' });
  const due = (await pools.root.query(`select first_response_due_on from hdt_tickets where ticket_id = $1`, [t.ticketId])).rows[0].first_response_due_on as Date;
  const after = new Date(due.getTime() + MINUTE);
  await ticketsMinute(SYSTEM, after);
  await ticketsMinute(SYSTEM, new Date(after.getTime() + MINUTE));
  // Обращения прошлых тестов тоже нарушают сроки: проверяется своё обращение.
  expect((await notices(f.l1.userId, 'sla_breach', t.ticketId)).map((n) => n.payload.breach)).toEqual(['first_response']);
  expect((await outbox(t.ticketId, 'staff_breach')).map((m) => [m.recipient_user_id, m.payload.kind])).toEqual([[f.l1.userId, 'first_response']]);
  // Руководитель второй линии о нарушении первой линии не уведомляется.
  await pools.root.query(`update hdu_staff set is_lead = true where user_id = $1`, [f.care.userId]);
  expect(await notices(f.care.userId, 'sla_breach', t.ticketId)).toEqual([]);
});

test('отложенное вернулось: исполнителю уведомление', async () => {
  const t = f.tickets.aOrg;
  await setState(t.ticketId, `assignee_id = $2, snoozed_until = now() - interval '1 minute'`, [f.l1.userId]);
  await ticketsMinute(SYSTEM, new Date());
  expect((await notices(f.l1.userId, 'snooze_returned')).map((n) => n.ticket_id)).toEqual([t.ticketId]);
});

/** Переносит начало периода "В разработке": служебные колонки защищены триггером, поэтому без триггеров. */
async function startPeriodAt(ticketId: string, start: Date): Promise<void> {
  const client = await pools.root.connect();
  try {
    await client.query('begin');
    await client.query('set local session_replication_role = replica');
    await client.query(`update hdt_tickets set created_on = $2::timestamptz - interval '1 hour' where ticket_id = $1`, [ticketId, start.toISOString()]);
    await client.query(`update hdt_ticket_messages set created_on = $2::timestamptz - interval '1 hour' where ticket_id = $1`, [ticketId, start.toISOString()]);
    await client.query(`update hdt_ticket_events set created_on = $2 where ticket_id = $1 and kind = 'status' and payload ->> 'to' = 'in_development'`, [ticketId, start.toISOString()]);
    await client.query('commit');
  } finally {
    client.release();
  }
}

// Начало периода задаётся явно: от времени запуска набора результат не зависит. Вечер вторника и пятницы
// проверяет срок, который по графику субботы или после неё короче четырёх суток (суббота до 17:00).
test.each([
  ['вторник 10:00', '2026-11-17T05:00:00Z'],
  ['вторник 19:30, срок в субботу до 17:00', '2026-11-17T14:30:00Z'],
  ['вторник 17:01', '2026-11-17T12:01:00Z'],
  ['пятница 19:30', '2026-11-20T14:30:00Z'],
  ['суббота 12:00', '2026-11-21T07:00:00Z'],
  ['воскресенье 03:00', '2026-11-22T22:00:00Z'],
])('"В разработке" 4 рабочих дня без ответа: напоминание исполнителю один раз (%s)', async (_name, iso) => {
  const t = f.tickets.aOrg;
  await setStatus(staffCtx(f.care), { number: t.number, to: 'in_progress' });
  await setStatus(staffCtx(f.care), { number: t.number, to: 'in_development' });
  await setState(t.ticketId, `assignee_id = $2`, [f.care.userId]);
  const start = new Date(iso);
  await startPeriodAt(t.ticketId, start);
  await ticketsMinute(SYSTEM, new Date(addWorkingDays(start, 3, TASHKENT_DEFAULT).getTime() + MINUTE));
  expect(await notices(f.care.userId, 'update_due')).toEqual([]);
  const due = addWorkingDays(start, 4, TASHKENT_DEFAULT);
  await ticketsMinute(SYSTEM, new Date(due.getTime() - MINUTE));
  expect(await notices(f.care.userId, 'update_due')).toEqual([]);
  const remindAt = new Date(due.getTime() + MINUTE);
  await ticketsMinute(SYSTEM, remindAt);
  await ticketsMinute(SYSTEM, new Date(remindAt.getTime() + MINUTE));
  expect((await notices(f.care.userId, 'update_due')).map((n) => n.ticket_id)).toEqual([t.ticketId]);
  expect((await outbox(t.ticketId, 'staff_update_due')).map((m) => m.recipient_user_id)).toEqual([f.care.userId]);
});

test('1 декабря без праздников следующего года: администраторам напоминание, с праздниками нет', async () => {
  const december = new Date('2026-12-01T05:00:00Z');
  await saveHolidays(staffCtx(f.adminStaff), { year: 2027, dates: [] });
  await ticketsMinute(SYSTEM, december);
  await ticketsMinute(SYSTEM, new Date(december.getTime() + MINUTE));
  expect((await notices(f.adminStaff.userId, 'holidays_reminder')).map((n) => n.payload.year)).toEqual([2027]);
  expect((await outbox(null, 'holidays_reminder')).map((m) => m.recipient_user_id)).toContain(f.adminStaff.userId);
  expect(await notices(f.l1.userId, 'holidays_reminder')).toEqual([]);
  // В ноябре напоминания нет; с праздниками следующего года тоже.
  await pools.root.query(`delete from hdn_notifications where kind = 'holidays_reminder'`);
  await ticketsMinute(SYSTEM, new Date('2026-11-30T05:00:00Z'));
  expect(await notices(f.adminStaff.userId, 'holidays_reminder')).toEqual([]);
  await saveHolidays(staffCtx(f.adminStaff), { year: 2027, dates: ['2027-01-01'] });
  await ticketsMinute(SYSTEM, december);
  expect(await notices(f.adminStaff.userId, 'holidays_reminder')).toEqual([]);
});

test('новое обращение P1: письмо дежурным и сообщение в чат один раз', async () => {
  const { number } = await createTicket(await clientCtx(f.aUser), { description: 'Склад стоит', type: 'bug', impact: 'blocker', locale: 'ru' });
  const ticketId = (await pools.root.query(`select ticket_id from hdt_tickets where number = $1`, [number])).rows[0].ticket_id as string;
  const rows = await outbox(ticketId, 'oncall_p1');
  expect(rows.map((r) => [r.channel, r.recipient_kind]).sort()).toEqual([
    ['email', 'oncall'],
    ['telegram', 'oncall'],
  ]);
  expect(rows[0]!.payload).toMatchObject({ number, url: `/agent/tickets/SUP-${number}`, orgName: f.orgA.name });
  // Подтверждение того же приоритета сотрудником второго сообщения не даёт.
  await setPriority(staffCtx(f.l1), { number, priority: 'p1', reason: 'Подтверждаю' });
  expect(await outbox(ticketId, 'oncall_p1')).toHaveLength(2);
  // Поднятие до P1 до первого ответа даёт сообщение.
  const t = f.tickets.aOrg;
  await setPriority(staffCtx(f.l1), { number: t.number, priority: 'p1', reason: 'Стоит склад' });
  expect(await outbox(t.ticketId, 'oncall_p1')).toHaveLength(2);
});

test('P1 поднят после первого ответа: сообщения нет', async () => {
  const t = f.tickets.aOrg;
  await postStaffMessage(staffCtx(f.l1), { number: t.number, body: 'Смотрим', internal: false, seenVersion: await versionOf(t.number) });
  await setPriority(staffCtx(f.l1), { number: t.number, priority: 'p1', reason: 'Стоит склад' });
  expect(await outbox(t.ticketId, 'oncall_p1')).toEqual([]);
});

test('выбран отдельный бот: сообщение уходит его токеном, основной бот не используется', async () => {
  const sent: { token: string; chatId: string; text: string }[] = [];
  setOncallBotFactoryForTests((token) => ({ send: async (chatId, text) => void sent.push({ token, chatId, text }) }));
  await setSetting('notify.oncall_chat_id', '-1001234567890');
  await setSetting('notify.oncall_bot', 'own');
  await saveOncallBotToken(f.adminStaff.actor, '123456:own-oncall-bot-token');
  const t = f.tickets.aOrg;
  await setPriority(staffCtx(f.l1), { number: t.number, priority: 'p1', reason: 'Стоит склад' });
  await dispatchOutbox(DISPATCH, new Date(), createMemoryEmailProvider());
  expect(sent.map((s) => [s.token, s.chatId])).toEqual([['123456:own-oncall-bot-token', '-1001234567890']]);
  expect(sent[0]!.text).toContain(`SUP-${t.number}`);
  expect(sent[0]!.text).not.toContain(t.title);
});

test('чат дежурных не задан: только письмо, очередь не падает', async () => {
  const provider = createMemoryEmailProvider();
  await setSetting('notify.oncall_emails', ['duty@smartup24.com']);
  const t = f.tickets.aOrg;
  await setPriority(staffCtx(f.l1), { number: t.number, priority: 'p1', reason: 'Стоит склад' });
  await dispatchOutbox(DISPATCH, new Date(), provider);
  expect(provider.sent.map((s) => s.message.to)).toEqual(['duty@smartup24.com']);
  const statuses = await pools.root.query(`select channel, status from hdn_outbox where ticket_id = $1 and template = 'oncall_p1' order by channel`, [t.ticketId]);
  expect(statuses.rows).toEqual([
    { channel: 'email', status: 'sent' },
    { channel: 'telegram', status: 'skipped' },
  ]);
});

test('токен бота не читается под клиентом и сотрудником кроме системы', async () => {
  await saveOncallBotToken(f.adminStaff.actor, '123456:secret-token-value');
  const sealed = (await pools.root.query(`select sealed from hdn_channel_secrets where code = 'oncall_telegram_bot'`)).rows[0].sealed as string;
  expect(sealed).not.toContain('secret-token-value');
  for (const actor of [f.aUser.actor, f.l1.actor, f.adminStaff.actor]) {
    const seen = await asActor(pools.app, actor, (c) => c.query(`select count(*)::int as n from hdn_channel_secrets`)).catch(() => ({ rows: [{ n: 0 }] }));
    expect(seen.rows[0].n).toBe(0);
  }
  // Сохранить токен может только администратор.
  await expect(saveOncallBotToken(f.l1.actor, '123456:another-token-value')).rejects.toThrow();
  // Напрямую в базу сотрудник и клиент секрет не пишут.
  await expect(asActor(pools.app, f.adminStaff.actor, (c) => c.query(`update hdn_channel_secrets set sealed = sealed`).then((r) => r.rowCount))).resolves.toBe(0);
});
