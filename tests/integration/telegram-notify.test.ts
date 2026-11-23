import { beforeEach, expect, test } from 'vitest';
import { withActor } from '@/db/with-actor';
import { getEnv } from '@/env';
import { savePrefs } from '@/modules/hdn/api/notifications';
import { dispatchOutbox } from '@/modules/hdn/api/outbox';
import { createMemoryEmailProvider, type MemoryEmailProvider } from '@/modules/hdn/testing';
import { getAgentTicket, postStaffMessage, setStatus } from '@/modules/hdt/api';
import { notifyTicketTx } from '@/modules/hdt/core/notify';
import { staffCtx } from './helpers/auth';
import { pools } from './helpers/db';
import { linkTelegramFixture, memoryBotPerTest } from './helpers/telegram';
import { type Fixture, seedTwoOrgs } from './isolation/fixture';

// Уведомления об обращениях в Telegram (FR-NT-14, FR-NT-15, FR-NT-09; план M4b, задача 2; решения 1, 2, 5 вехи M4b).
// Строка очереди channel = 'telegram' ставится в транзакции события; чат берётся в момент отправки.

const OUTBOX = { type: 'system', job: 'outbox.dispatch' } as const;
const tg = memoryBotPerTest();
let f: Fixture;
let mail: MemoryEmailProvider;
beforeEach(async () => {
  f = await seedTwoOrgs();
  mail = createMemoryEmailProvider();
});

type Row = { channel: string; recipient_user_id: string; template: string; status: string; payload: Record<string, unknown>; last_error: string | null };
// Без отправленного письма из общего набора данных изоляции.
const rows = (ticketId: string, channel = 'telegram') =>
  pools.root
    .query<Row>(
      `select channel, recipient_user_id, template, status, payload, last_error from hdn_outbox where ticket_id = $1 and channel = $2 and coalesce(external_id, '') not like 'fixture-%' order by created_on, outbox_id`,
      [ticketId, channel],
    )
    .then((r) => r.rows);
const versionOf = async (number: number) => (await getAgentTicket(staffCtx(f.l1), number))?.version ?? '';
const reply = async (number: number, body: string) => postStaffMessage(staffCtx(f.l1), { number, body, internal: false, seenVersion: await versionOf(number) });
const dispatch = (at = new Date()) => dispatchOutbox(OUTBOX, at, mail, null);
const watch = (userId: string) =>
  pools.root.query(`insert into hdt_ticket_watchers (org_id, ticket_id, user_id, source) values ($1, $2, $3, 'manual')`, [f.orgA.orgId, f.tickets.aOrg.ticketId, userId]);

test('ответ сотрудника: автору с привязкой одно сообщение в Telegram с номером и кнопкой, без текста ответа', async () => {
  const t = f.tickets.aOrg;
  await linkTelegramFixture(f.aUser, 700001);
  await reply(t.number, 'Секретный ответ: перезапустите сервер');
  const queued = await rows(t.ticketId);
  expect(queued.map((r) => [r.recipient_user_id, r.template, r.status])).toEqual([[f.aUser.userId, 'ticket_reply', 'queued']]);
  // Текст ответа в строке Telegram не хранится.
  expect(JSON.stringify(queued[0]!.payload)).not.toContain('Секретный');
  // Письмо автору уходит по-прежнему.
  expect((await rows(t.ticketId, 'email')).map((r) => r.recipient_user_id)).toEqual([f.aUser.userId]);
  await dispatch();
  expect(tg.bot.sent).toHaveLength(1);
  const sent = tg.bot.sent[0]!;
  expect(sent.chatId).toBe('700001');
  expect(sent.text).toContain(`SUP-${t.number}`);
  expect(sent.text).toContain('Новый ответ поддержки');
  expect(sent.text).not.toContain('Секретный');
  expect(sent.linkButton).toEqual({ text: 'Открыть в портале', url: `${getEnv().HUB_URL}/ru/tickets/SUP-${t.number}` });
  // Повторная отправка очереди второго сообщения не даёт.
  await dispatch(new Date(Date.now() + 10 * 60_000));
  expect(tg.bot.sent).toHaveLength(1);
  expect((await rows(t.ticketId))[0]!.status).toBe('sent');
});

test('наблюдатель с выключенным Telegram для чужих обращений сообщения не получает, письмо по своей настройке', async () => {
  const t = f.tickets.aOrg;
  await watch(f.aAdmin.userId);
  await linkTelegramFixture(f.aAdmin, 700002);
  await savePrefs(f.aAdmin.actor, { own: { email: true, telegram: true }, watched: { email: true, telegram: false } });
  await reply(t.number, 'Ответ');
  expect(await rows(t.ticketId)).toEqual([]);
  expect((await rows(t.ticketId, 'email')).map((r) => r.recipient_user_id).sort()).toEqual([f.aUser.userId, f.aAdmin.userId].sort());
  // Включил Telegram для чужих обращений и выключил почту: только Telegram.
  await savePrefs(f.aAdmin.actor, { own: { email: true, telegram: true }, watched: { email: false, telegram: true } });
  await reply(t.number, 'Ещё ответ');
  expect((await rows(t.ticketId)).map((r) => r.recipient_user_id)).toEqual([f.aAdmin.userId]);
});

const verifyEmail = (userId: string, address: string) =>
  pools.root.query(`update auth."user" set email = $2, "emailVerified" = true where id = $1`, [userId, address]);
const fallbackRows = (ticketId: string) =>
  pools.root
    .query<{ status: string; fallback_for: string | null }>(`select status, fallback_for from hdn_outbox where ticket_id = $1 and channel = 'email' and fallback_for is not null`, [ticketId])
    .then((r) => r.rows);

test('почта о своих обращениях выключена и Telegram доставил: запасное письмо не уходит', async () => {
  const t = f.tickets.aOrg;
  await verifyEmail(f.aUser.userId, 'a-user@example.uz');
  await linkTelegramFixture(f.aUser, 700003);
  await savePrefs(f.aUser.actor, { own: { email: false, telegram: true }, watched: { email: true, telegram: true } });
  await reply(t.number, 'Ответ');
  expect((await rows(t.ticketId)).map((r) => r.recipient_user_id)).toEqual([f.aUser.userId]);
  // Письмо ставится запасным к строке Telegram и ждёт: обычного письма нет.
  expect(await fallbackRows(t.ticketId)).toHaveLength(1);
  expect((await rows(t.ticketId, 'email')).length).toBe(1);
  const now = Date.now();
  await dispatch(new Date(now));
  expect(tg.bot.sent).toHaveLength(1);
  expect(mail.sent).toEqual([]);
  await dispatch(new Date(now + 6 * 60_000));
  expect(mail.sent).toEqual([]);
  expect((await fallbackRows(t.ticketId))[0]!.status).toBe('skipped');
});

test('почта о своих обращениях выключена, бот заблокирован: письмо об этом же событии уходит запасным (итоговая проверка, I1)', async () => {
  const t = f.tickets.aOrg;
  await verifyEmail(f.aUser.userId, 'a-user@example.uz');
  await linkTelegramFixture(f.aUser, 700012);
  await savePrefs(f.aUser.actor, { own: { email: false, telegram: true }, watched: { email: true, telegram: true } });
  await reply(t.number, 'Ответ после блокировки бота');
  const now = Date.now();
  tg.bot.failNext(403);
  await dispatch(new Date(now));
  expect((await rows(t.ticketId))[0]!.status).toBe('skipped');
  expect(mail.sent).toEqual([]);
  await dispatch(new Date(now + 6 * 60_000));
  expect(mail.sent.map((s) => s.message.to)).toEqual(['a-user@example.uz']);
  expect(mail.sent[0]!.message.text).toContain('Ответ после блокировки бота');
  // Telegram недоступен дольше срока ожидания: письмо уходит тоже, сообщение в Telegram может прийти позже.
  await reply(t.number, 'Второй ответ');
  expect(await rows(t.ticketId, 'email').then((r) => r.filter((x) => x.status === 'queued').length)).toBe(1);
});

test('отвязал Telegram после постановки: строка skipped, сообщения нет', async () => {
  const t = f.tickets.aOrg;
  await linkTelegramFixture(f.aUser, 700004);
  await reply(t.number, 'Ответ');
  await pools.root.query(`delete from hdu_contact_identities where user_id = $1`, [f.aUser.userId]);
  await dispatch();
  expect(tg.bot.sent).toEqual([]);
  expect((await rows(t.ticketId))[0]!.status).toBe('skipped');
});

test('Telegram ответил 403: привязка отмечена заблокированной, строка skipped, следующие события в Telegram не ставятся', async () => {
  const t = f.tickets.aOrg;
  await linkTelegramFixture(f.aUser, 700005);
  await reply(t.number, 'Ответ');
  tg.bot.failNext(403);
  await dispatch();
  expect(tg.bot.sent).toEqual([]);
  expect((await rows(t.ticketId))[0]!.status).toBe('skipped');
  expect((await pools.root.query(`select is_blocked from hdu_contact_identities where user_id = $1`, [f.aUser.userId])).rows[0].is_blocked).toBe(true);
  await reply(t.number, 'Второй ответ');
  expect(await rows(t.ticketId)).toHaveLength(1);
  // Письмо о втором ответе уходит: Telegram не действует.
  expect((await rows(t.ticketId, 'email')).map((r) => r.template)).toEqual(['ticket_reply', 'ticket_reply']);
});

test('Telegram ответил 429 или не ответил: строка ждёт повтора, сообщение не потеряно', async () => {
  const t = f.tickets.aOrg;
  await linkTelegramFixture(f.aUser, 700006);
  await reply(t.number, 'Ответ');
  const now = Date.now();
  tg.bot.failNext(429);
  await dispatch(new Date(now));
  expect((await rows(t.ticketId))[0]).toMatchObject({ status: 'queued', last_error: 'код 429' });
  tg.bot.failNext(null);
  await dispatch(new Date(now + 2 * 60_000));
  expect((await rows(t.ticketId))[0]).toMatchObject({ status: 'queued', last_error: 'нет ответа' });
  expect((await pools.root.query(`select is_blocked from hdu_contact_identities where user_id = $1`, [f.aUser.userId])).rows[0].is_blocked).toBe(false);
  await dispatch(new Date(now + 10 * 60_000));
  expect(tg.bot.sent).toHaveLength(1);
  expect((await rows(t.ticketId))[0]!.status).toBe('sent');
});

test('откат транзакции события: сообщения нет', async () => {
  const t = f.tickets.aOrg;
  await linkTelegramFixture(f.aUser, 700007);
  await expect(
    withActor(f.l1.actor, async (tx) => {
      await notifyTicketTx(tx, { ticketId: t.ticketId, kind: 'status', actorUserId: f.l1.userId, to: 'waiting_customer' });
      throw new Error('откат');
    }),
  ).rejects.toThrow('откат');
  expect(await rows(t.ticketId)).toEqual([]);
  await dispatch();
  expect(tg.bot.sent).toEqual([]);
});

test('сообщение на языке пользователя, тема обрезана до 60 знаков, без режима разметки', async () => {
  const t = f.tickets.aOrg;
  await linkTelegramFixture(f.aUser, 700008);
  await pools.root.query(`update auth."user" set locale = 'uz' where id = $1`, [f.aUser.userId]);
  await pools.root.query(`update hdt_tickets set title = $2 where ticket_id = $1`, [t.ticketId, `<b>Срочно</b> http://evil.example ${'длинная тема '.repeat(12)}`]);
  await setStatus(staffCtx(f.l1), { number: t.number, to: 'waiting_customer', version: await versionOf(t.number) });
  await dispatch();
  expect(tg.bot.sent).toHaveLength(1);
  const sent = tg.bot.sent[0]!;
  expect(sent.text.split('\n')[1]).toBe('Javobingizni kutyapmiz.');
  const shown = sent.text.split('\n')[0]!.replace(`SUP-${t.number} · `, '');
  expect(Array.from(shown)).toHaveLength(60);
  expect(shown).not.toContain('://');
  expect(sent.linkButton?.url).toBe(`${getEnv().HUB_URL}/uz/tickets/SUP-${t.number}`);
  expect(Object.keys(sent).sort()).toEqual(['chatId', 'linkButton', 'text']);
});

test('отключённый участник и подписчик личного обращения сообщений не получают', async () => {
  const t = f.tickets.aOrg;
  await watch(f.aAdmin.userId);
  await linkTelegramFixture(f.aAdmin, 700009);
  await linkTelegramFixture(f.aUser, 700010);
  await pools.root.query(`update hdu_memberships set state = 'passive' where user_id = $1 and org_id = $2`, [f.aAdmin.userId, f.orgA.orgId]);
  await reply(t.number, 'Ответ');
  expect((await rows(t.ticketId)).map((r) => r.recipient_user_id)).toEqual([f.aUser.userId]);
  // Личное обращение администратора: подписанный коллега без прав администратора его не видит.
  await pools.root.query(`update hdu_memberships set state = 'active' where user_id = $1 and org_id = $2`, [f.aAdmin.userId, f.orgA.orgId]);
  await pools.root.query(`update hdt_tickets set author_id = $2, visibility = 'private' where ticket_id = $1`, [t.ticketId, f.aAdmin.userId]);
  await pools.root.query(`insert into hdt_ticket_watchers (org_id, ticket_id, user_id, source) values ($1, $2, $3, 'manual') on conflict do nothing`, [f.orgA.orgId, t.ticketId, f.aUser.userId]);
  await pools.root.query(`delete from hdn_outbox where ticket_id = $1`, [t.ticketId]);
  await reply(t.number, 'Ответ администратору');
  expect((await rows(t.ticketId)).map((r) => r.recipient_user_id)).toEqual([f.aAdmin.userId]);
});
