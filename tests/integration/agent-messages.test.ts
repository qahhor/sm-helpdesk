import { afterEach, beforeEach, expect, test } from 'vitest';
import { MemoryJobQueue, MemoryStorage, setJobQueueForTests, setStorageForTests } from '@/modules/hdc/testing';
import {
  createTicket,
  getAgentTicket,
  getTicket,
  listPresence,
  loadDraft,
  postStaffMessage,
  presignStaffUpload,
  replyToTicket,
  saveDraft,
  setStatus,
  touchPresence,
} from '@/modules/hdt/api';
import { clientCtx, staffCtx, staffWithRole } from './helpers/auth';
import { asActor, pools } from './helpers/db';
import { seedTwoOrgs } from './isolation/fixture';

// Ответ клиенту, заметка, черновик, упоминания, присутствие (FR-AG-03, 12, 21, FR-SLA-04, FR-LINE-07, UX-A-05..07;
// план M3, задача 8, решения 6 и 10).

beforeEach(() => {
  setStorageForTests(new MemoryStorage());
  setJobQueueForTests(new MemoryJobQueue());
});
afterEach(() => {
  setStorageForTests(null);
  setJobQueueForTests(null);
});

const row = (ticketId: string) =>
  pools.root
    .query(`select status, assignee_id, first_responded_on, client_waiting_since, sla_paused_on from hdt_tickets where ticket_id = $1`, [ticketId])
    .then((r) => r.rows[0]);
// Сообщения, добавленные тестом: публичное сообщение и заметка набора изоляции не считаются.
const FIXTURE_BODIES = ['Публичное сообщение', 'Внутренняя заметка'];
const messages = (ticketId: string) =>
  pools.root
    .query(`select message_id, body, is_internal, author_type, author_id from hdt_ticket_messages where ticket_id = $1 order by created_on, message_id`, [ticketId])
    .then((r) => r.rows.filter((m) => !FIXTURE_BODIES.includes(m.body)));
const statusEvents = (ticketId: string) =>
  pools.root
    .query(`select payload from hdt_ticket_events where ticket_id = $1 and kind = 'status' order by created_on, event_id`, [ticketId])
    .then((r) => r.rows.map((x) => x.payload));
const versionOf = async (ctx: ReturnType<typeof staffCtx>, number: number) => {
  const view = await getAgentTicket(ctx, number);
  if (!view) throw new Error('обращение не найдено');
  return view.version;
};

test('первый публичный ответ останавливает срок первого ответа, заметка и смена статуса нет', async () => {
  const f = await seedTwoOrgs();
  const l1 = staffCtx(f.l1);
  const t = f.tickets.aOrg;
  const seenVersion = await versionOf(l1, t.number);
  expect((await row(t.ticketId)).client_waiting_since).not.toBeNull();
  expect(await postStaffMessage(l1, { number: t.number, body: 'Проверю логи сервера', internal: true, seenVersion })).toEqual({ ok: true });
  await setStatus(l1, { number: t.number, to: 'in_progress' });
  let r = await row(t.ticketId);
  expect(r.first_responded_on).toBeNull();
  expect(r.client_waiting_since).not.toBeNull();
  // Своя заметка и своя смена статуса не считаются изменением "пока писал".
  expect(await postStaffMessage(l1, { number: t.number, body: 'Отчёт заработал, обновите страницу', internal: false, seenVersion })).toEqual({ ok: true });
  r = await row(t.ticketId);
  expect(r.first_responded_on).not.toBeNull();
  expect(r.client_waiting_since).toBeNull();
  const first = r.first_responded_on.toISOString();
  await postStaffMessage(l1, { number: t.number, body: 'И ещё одно уточнение', internal: false, seenVersion: await versionOf(l1, t.number) });
  expect((await row(t.ticketId)).first_responded_on.toISOString()).toBe(first);
  expect((await messages(t.ticketId)).map((m) => [m.body, m.is_internal, m.author_type])).toEqual([
    ['Проверю логи сервера', true, 'staff'],
    ['Отчёт заработал, обновите страницу', false, 'staff'],
    ['И ещё одно уточнение', false, 'staff'],
  ]);
});

test('ответ на новое обращение без исполнителя делает ответившего исполнителем, статус "В работе"', async () => {
  const f = await seedTwoOrgs();
  const care = staffCtx(f.care);
  const { number } = await createTicket(await clientCtx(f.aUser), { description: 'Не печатается накладная', type: 'bug', impact: 'minor', locale: 'ru' });
  const ticketId = (await pools.root.query(`select ticket_id from hdt_tickets where number = $1`, [number])).rows[0].ticket_id as string;
  expect((await row(ticketId)).assignee_id).toBeNull();
  await postStaffMessage(care, { number, body: 'Посмотрю сейчас', internal: false, seenVersion: await versionOf(care, number) });
  expect(await row(ticketId)).toMatchObject({ status: 'in_progress', assignee_id: f.care.userId });
  expect(await statusEvents(ticketId)).toEqual([{ from: 'new', to: 'in_progress' }]);
  // Исполнитель уже есть: остаётся, статус всё равно "В работе".
  const t = f.tickets.aMine;
  await pools.root.query(`update hdt_tickets set assignee_id = $2 where ticket_id = $1`, [t.ticketId, f.l1.userId]);
  await postStaffMessage(care, { number: t.number, body: 'Отвечаю за коллегу', internal: false, seenVersion: await versionOf(care, t.number) });
  expect(await row(t.ticketId)).toMatchObject({ status: 'in_progress', assignee_id: f.l1.userId });
});

test('"Ждём ответа клиента" ставит статус и паузу тем же действием', async () => {
  const f = await seedTwoOrgs();
  const l1 = staffCtx(f.l1);
  const t = f.tickets.aOrg;
  const seenVersion = await versionOf(l1, t.number);
  await expect(postStaffMessage(l1, { number: t.number, body: 'Заметка', internal: true, waitForClient: true, seenVersion })).rejects.toMatchObject({
    code: 'invalid_input',
  });
  await postStaffMessage(l1, { number: t.number, body: 'Пришлите, пожалуйста, снимок экрана', internal: false, waitForClient: true, seenVersion });
  const r = await row(t.ticketId);
  expect(r.status).toBe('waiting_customer');
  expect(r.sla_paused_on).not.toBeNull();
  expect(r.first_responded_on).not.toBeNull();
  expect(await statusEvents(t.ticketId)).toEqual([{ from: 'new', to: 'waiting_customer' }]);
});

test('обращение изменилось после открытия: ответ не уходит, сводка изменений; повтор уходит', async () => {
  const f = await seedTwoOrgs();
  const l1 = staffCtx(f.l1);
  const t = f.tickets.aOrg;
  const seenVersion = await versionOf(l1, t.number);
  await replyToTicket(await clientCtx(f.aUser), { number: t.number, body: 'Уже не нужно, само заработало' });
  await setStatus(staffCtx(f.care), { number: t.number, to: 'in_progress' });
  const before = (await messages(t.ticketId)).length;
  const refused = await postStaffMessage(l1, { number: t.number, body: 'Проверьте ещё раз', internal: false, seenVersion });
  expect(refused).toEqual({ ok: false, changed: { newMessages: 1, statusChanged: true, assigneeChanged: false }, version: await versionOf(l1, t.number) });
  expect(await messages(t.ticketId)).toHaveLength(before);
  expect((await row(t.ticketId)).first_responded_on).toBeNull();
  // Агент увидел сводку и решил отправить: повтор с версией из отказа уходит.
  if (refused.ok) throw new Error('ожидался отказ');
  expect(await postStaffMessage(l1, { number: t.number, body: 'Проверьте ещё раз', internal: false, seenVersion: refused.version })).toEqual({ ok: true });
  expect(await messages(t.ticketId)).toHaveLength(before + 1);
  await expect(postStaffMessage(l1, { number: t.number, body: 'x', internal: false, seenVersion: 'вчера' })).rejects.toMatchObject({ code: 'invalid_input' });
});

test('заметка и её файлы клиенту не видны, упоминание создаёт строку для упомянутого', async () => {
  const f = await seedTwoOrgs();
  const l1 = staffCtx(f.l1);
  const t = f.tickets.aOrg;
  const { attachmentId } = await presignStaffUpload(l1, { number: t.number, fileName: 'лог.txt', size: 4, mime: 'text/plain' });
  await postStaffMessage(l1, {
    number: t.number,
    body: '@Камила посмотри, похоже на ошибку в отчёте',
    internal: true,
    attachmentIds: [attachmentId],
    seenVersion: await versionOf(l1, t.number),
  });
  const note = (await messages(t.ticketId)).find((m) => m.is_internal && m.body.startsWith('@Камила'));
  expect(note).toBeDefined();
  expect((await pools.root.query(`select user_id, read_on from hdt_mentions where message_id = $1`, [note.message_id])).rows).toEqual([
    { user_id: f.care.userId, read_on: null },
  ]);
  expect((await pools.root.query(`select is_internal, message_id from hdt_attachments where attachment_id = $1`, [attachmentId])).rows[0]).toEqual({
    is_internal: true,
    message_id: note.message_id,
  });
  // Публичный ответ упоминаний не создаёт: "@" в нём обычный текст.
  await postStaffMessage(l1, { number: t.number, body: '@Камила уже смотрит', internal: false, seenVersion: await versionOf(l1, t.number) });
  expect((await pools.root.query(`select count(*)::int as n from hdt_mentions`)).rows[0].n).toBe(1);
  const view = await getTicket(await clientCtx(f.aUser), t.number);
  expect(view?.messages.map((m) => m.body)).toEqual(['Публичное сообщение', '@Камила уже смотрит']);
  expect(JSON.stringify(view)).not.toContain(attachmentId);
  const visible = await asActor(pools.app, f.aUser.actor, (c) => c.query(`select count(*)::int as n from hdt_mentions`).then((r) => r.rows[0].n));
  expect(visible).toBe(0);
});

test('черновик: виден только автору, с другого устройства, удаляется после отправки', async () => {
  const f = await seedTwoOrgs();
  const t = f.tickets.aOrg;
  await saveDraft(staffCtx(f.l1), { number: t.number, body: 'Добрый день! Проверили', internal: false });
  // Другое устройство: новая сессия того же сотрудника.
  expect(await loadDraft(staffCtx(f.l1), t.number)).toMatchObject({ body: 'Добрый день! Проверили', internal: false });
  expect(await loadDraft(staffCtx(f.care), t.number)).toBeNull();
  expect(await asActor(pools.app, f.care.actor, (c) => c.query(`select count(*)::int as n from hdt_reply_drafts`).then((r) => r.rows[0].n))).toBe(0);
  await saveDraft(staffCtx(f.l1), { number: t.number, body: 'Заметка в работе', internal: true });
  expect(await loadDraft(staffCtx(f.l1), t.number)).toMatchObject({ body: 'Заметка в работе', internal: true });
  await saveDraft(staffCtx(f.l1), { number: t.number, body: '   ', internal: true });
  expect(await loadDraft(staffCtx(f.l1), t.number)).toBeNull();
  await saveDraft(staffCtx(f.l1), { number: t.number, body: 'Сейчас отправлю', internal: false });
  await postStaffMessage(staffCtx(f.l1), { number: t.number, body: 'Сейчас отправлю', internal: false, seenVersion: await versionOf(staffCtx(f.l1), t.number) });
  expect(await loadDraft(staffCtx(f.l1), t.number)).toBeNull();
  const product = staffCtx(await staffWithRole('product'));
  await expect(saveDraft(product, { number: t.number, body: 'x', internal: false })).rejects.toMatchObject({ code: 'forbidden' });
  await expect(postStaffMessage(product, { number: t.number, body: 'x', internal: true, seenVersion: await versionOf(product, t.number) })).rejects.toMatchObject({
    code: 'forbidden',
  });
});

test('присутствие: видно открывших и печатающих, строка старше минуты не показывается', async () => {
  const f = await seedTwoOrgs();
  const t = f.tickets.aOrg;
  await touchPresence(staffCtx(f.l1), { number: t.number, mode: 'viewing' });
  await touchPresence(staffCtx(f.care), { number: t.number, mode: 'typing' });
  expect(await listPresence(staffCtx(f.l1), t.number)).toEqual([{ userId: f.care.userId, name: 'Камила', mode: 'typing' }]);
  expect(await listPresence(staffCtx(f.care), t.number)).toEqual([{ userId: f.l1.userId, name: 'Азиз', mode: 'viewing' }]);
  const expires = (await pools.root.query(`select expires_on - now() as left from hdt_ticket_presence where user_id = $1`, [f.care.userId])).rows[0].left;
  expect(expires.seconds ?? 0).toBeGreaterThan(50);
  await pools.root.query(`update hdt_ticket_presence set expires_on = now() - interval '1 second' where user_id = $1`, [f.care.userId]);
  expect(await listPresence(staffCtx(f.l1), t.number)).toEqual([]);
  await expect(touchPresence(staffCtx(f.l1), { number: t.number, mode: 'dancing' })).rejects.toMatchObject({ code: 'invalid_input' });
});

test('клиент видит ответ с подписью "Поддержка Smartup", без имени сотрудника и без заметок', async () => {
  const f = await seedTwoOrgs();
  const l1 = staffCtx(f.l1);
  const t = f.tickets.aOrg;
  await postStaffMessage(l1, { number: t.number, body: 'Внутреннее: клиент на старой версии', internal: true, seenVersion: await versionOf(l1, t.number) });
  await postStaffMessage(l1, { number: t.number, body: 'Обновите, пожалуйста, приложение', internal: false, seenVersion: await versionOf(l1, t.number) });
  const view = await getTicket(await clientCtx(f.aUser), t.number);
  expect(view?.messages.map((m) => [m.authorType, m.authorName, m.body])).toEqual([
    ['client', 'Алишер', 'Публичное сообщение'],
    ['staff', null, 'Обновите, пожалуйста, приложение'],
  ]);
  expect(JSON.stringify(view)).not.toContain('Азиз');
  expect(JSON.stringify(view)).not.toContain('старой версии');
});
