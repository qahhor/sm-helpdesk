import { createHash } from 'node:crypto';
import { beforeEach, expect, test } from 'vitest';
import { applyGuestMerges, bindTicket, getAgentTicket, inviteSender, listQueue, listUnidentified, markNotClient, markSpam, postStaffMessage, queueCounts, unidentifiedCount } from '@/modules/hdt/api';
import { recordDelivery } from '@/modules/hdn/api/outbox';
import { acceptInvitation, completeLoginLink, confirmEmail, requestEmailConfirmation, requestLoginLink } from '@/modules/hdu/api';
import { clientCtx, clientSession, newJar, noRequest, staffCtx, staffWithRole } from './helpers/auth';
import { asActor, pools } from './helpers/db';
import { deliver as deliverTo, inboundPerTest, type Letter } from './helpers/inbound';
import { memoryMailerPerTest, tokenFrom } from './helpers/mail';
import { type Fixture, seedTwoOrgs } from './isolation/fixture';

// Очередь "Неопознанные", привязка и переход гостя к клиенту (FR-EM-04, FR-EM-06, решения 12-15 вехи M4, сценарий 17).

const SERVICE_ORG_ID = '00000000-0000-7000-8000-000000000001';
const SYSTEM = { type: 'system', job: 'tickets.minute' } as const;

const box = inboundPerTest();
const mail = memoryMailerPerTest();
let f: Fixture;

beforeEach(async () => {
  f = await seedTwoOrgs();
});

const deliver = (letter: Letter) => deliverTo(box, letter);
/** Письмо с неизвестного адреса: обращение в "Неопознанных". */
async function unknownLetter(from = 'Bobur <bobur@unknown.uz>', subject = 'Хотим подключить склад') {
  const { inboundId } = await deliver({ from, subject, text: 'Расскажите, как подключить склад' });
  const row = (
    await pools.root.query(`select t.ticket_id, t.number, t.author_id from hdn_email_inbound i join hdt_tickets t on t.ticket_id = i.ticket_id where i.inbound_id = $1`, [inboundId])
  ).rows[0];
  return { ticket_id: row.ticket_id as string, number: Number(row.number), author_id: row.author_id as string };
}
const ticketRow = (ticketId: string) =>
  pools.root.query(`select org_id, visibility, status, author_id, closed_on from hdt_tickets where ticket_id = $1`, [ticketId]).then((r) => r.rows[0]);
const sees = async (actor: Parameters<typeof asActor>[1], ticketId: string) =>
  (await asActor(pools.app, actor, (c) => c.query(`select count(*)::int as n from hdt_tickets where ticket_id = $1`, [ticketId]))).rows[0].n as number;
const pendingInvitations = (email: string) =>
  pools.root
    .query(`select org_id, guest_user_id from hdu_invitations where email = $1 and accepted_on is null and revoked_on is null`, [email])
    .then((r) => r.rows);

test('привязка: обращение в организации клиента, видно её участникам, приглашение гостю, аудит', async () => {
  const t = await unknownLetter();
  const l1 = staffCtx(f.l1);
  const list = await listUnidentified(l1);
  expect(list.count).toBe(1);
  expect(list.items).toEqual([expect.objectContaining({ number: t.number, fromAddress: 'bobur@unknown.uz', fromName: 'Bobur', title: 'Хотим подключить склад' })]);
  expect(await bindTicket(l1, { number: t.number, orgId: f.orgA.orgId })).toEqual({ invited: true });
  expect(await ticketRow(t.ticket_id)).toMatchObject({ org_id: f.orgA.orgId, visibility: 'org' });
  // Сообщения, события и подписки переехали вместе с обращением.
  const strays = await pools.root.query(
    `select (select count(*) from hdt_ticket_events where ticket_id = $1 and org_id <> $2) + (select count(*) from hdt_ticket_watchers where ticket_id = $1 and org_id <> $2) as n`,
    [t.ticket_id, f.orgA.orgId],
  );
  expect(Number(strays.rows[0].n)).toBe(0);
  expect(await sees(f.aUser.actor, t.ticket_id)).toBe(1);
  expect(await sees(f.bUser.actor, t.ticket_id)).toBe(0);
  const event = await pools.root.query(`select is_internal, payload from hdt_ticket_events where ticket_id = $1 and kind = 'bound'`, [t.ticket_id]);
  expect(event.rows).toEqual([{ is_internal: true, payload: { orgId: f.orgA.orgId } }]);
  expect((await pools.root.query(`select action from hdc_audit_log where object_id = $1 and action = 'ticket.bound'`, [t.ticket_id])).rows).toHaveLength(1);
  expect(await pendingInvitations('bobur@unknown.uz')).toEqual([{ org_id: f.orgA.orgId, guest_user_id: t.author_id }]);
  expect(mail.mailer.sent.map((m) => [m.to, m.kind])).toEqual([['bobur@unknown.uz', 'invitation']]);
  expect((await pools.root.query(`select source from hdu_memberships where user_id = $1 and org_id = $2`, [t.author_id, f.orgA.orgId])).rows).toEqual([{ source: 'guest' }]);
  expect((await listUnidentified(l1)).count).toBe(0);
});

test('приглашение принято новой учётной записью: обращения гостя у неё', async () => {
  const t = await unknownLetter();
  await bindTicket(staffCtx(f.l1), { number: t.number, orgId: f.orgA.orgId });
  expect(await acceptInvitation({ token: tokenFrom(mail.mailer.sent[0]), name: 'Бобур' }, noRequest)).toEqual({ ok: true });
  const user = (await pools.root.query(`select id from auth."user" where email = 'bobur@unknown.uz'`)).rows[0].id as string;
  expect(user).not.toBe(t.author_id);
  expect(await applyGuestMerges(SYSTEM)).toBeGreaterThanOrEqual(1);
  expect((await ticketRow(t.ticket_id)).author_id).toBe(user);
  const messages = await pools.root.query(`select count(*)::int as n from hdt_ticket_watchers where ticket_id = $1 and user_id = $2 and source = 'author'`, [t.ticket_id, user]);
  expect(messages.rows[0].n).toBe(1);
  expect((await pools.root.query(`select state from hdu_memberships where user_id = $1`, [t.author_id])).rows.every((r) => r.state === 'passive')).toBe(true);
  // Повтор шага ничего не делает.
  expect(await applyGuestMerges(SYSTEM)).toBe(0);
});

test('приглашение принято существующей учётной записью с этим адресом: обращения гостя у неё', async () => {
  const t = await unknownLetter('bobur@unknown.uz');
  await pools.root.query(`update auth."user" set email = 'bobur@unknown.uz', "emailVerified" = true where id = $1`, [f.bUser.userId]);
  await bindTicket(staffCtx(f.l1), { number: t.number, orgId: f.orgA.orgId });
  const invitation = tokenFrom(mail.mailer.sent[0]);
  // Вход по ссылке на этот адрес: существующая учётная запись принимает приглашение из своей сессии.
  const jar = newJar();
  await requestLoginLink({ email: 'bobur@unknown.uz', locale: 'ru' }, noRequest);
  expect(await completeLoginLink({ token: tokenFrom(mail.mailer.sent[1]), locale: 'ru' }, jar.request)).toMatchObject({ ok: true });
  expect(await acceptInvitation({ token: invitation }, jar.request)).toEqual({ ok: true });
  await applyGuestMerges(SYSTEM);
  expect((await ticketRow(t.ticket_id)).author_id).toBe(f.bUser.userId);
});

test('адрес подтверждён в профиле после входа через Smartup: обращения гостя у этого пользователя', async () => {
  const t = await unknownLetter('bobur@unknown.uz');
  await bindTicket(staffCtx(f.l1), { number: t.number, orgId: f.orgB.orgId });
  mail.mailer.sent.splice(0);
  await requestEmailConfirmation(await clientCtx(f.bUser), { email: 'bobur@unknown.uz', locale: 'ru' });
  expect(await confirmEmail({ token: tokenFrom(mail.mailer.sent[0]) }, await clientSession(f.bUser))).toEqual({ ok: true });
  expect(await applyGuestMerges(SYSTEM)).toBeGreaterThanOrEqual(1);
  expect((await ticketRow(t.ticket_id)).author_id).toBe(f.bUser.userId);
  expect(await sees(f.bUser.actor, t.ticket_id)).toBe(1);
});

test('повтор приглашения после сбоя: одно приглашение', async () => {
  const t = await unknownLetter();
  // Предел приглашений в организацию исчерпан: привязка проходит, приглашение нет.
  const code = `invitations:org:${createHash('sha256').update(f.orgA.orgId).digest('hex').slice(0, 32)}`;
  await pools.root.query(`insert into hdc_rate_limits (code, window_on, hits) values ($1, now(), 1000)`, [code]);
  const l1 = staffCtx(f.l1);
  expect(await bindTicket(l1, { number: t.number, orgId: f.orgA.orgId })).toEqual({ invited: false });
  expect(await ticketRow(t.ticket_id)).toMatchObject({ org_id: f.orgA.orgId });
  expect(await pendingInvitations('bobur@unknown.uz')).toEqual([]);
  await pools.root.query(`delete from hdc_rate_limits`);
  expect(await inviteSender(l1, t.number)).toEqual({ invited: true });
  expect(await inviteSender(l1, t.number)).toEqual({ invited: true });
  expect(await pendingInvitations('bobur@unknown.uz')).toHaveLength(1);
});

test('"Спам": обращение закрыто без письма, следующее письмо с адреса без обращения', async () => {
  const t = await unknownLetter('spammer@unknown.uz');
  const outboxBefore = (await pools.root.query(`select count(*)::int as n from hdn_outbox`)).rows[0].n;
  await markSpam(staffCtx(f.l1), t.number);
  expect(await ticketRow(t.ticket_id)).toMatchObject({ status: 'closed' });
  expect((await pools.root.query(`select payload from hdt_ticket_events where ticket_id = $1 and kind = 'status'`, [t.ticket_id])).rows).toEqual([
    { payload: { from: 'new', to: 'closed', reason: 'spam' } },
  ]);
  expect((await pools.root.query(`select count(*)::int as n from hdn_outbox`)).rows[0].n).toBe(outboxBefore);
  expect((await pools.root.query(`select blocked_by from hdn_blocked_senders where address = 'spammer@unknown.uz'`)).rows).toEqual([{ blocked_by: f.l1.userId }]);
  expect((await deliver({ from: 'spammer@unknown.uz', subject: 'Снова' })).result).toBe('spam');
});

test('"Это не клиент": закрыто без письма', async () => {
  const t = await unknownLetter('vendor@unknown.uz');
  await markNotClient(staffCtx(f.l1), t.number);
  expect(await ticketRow(t.ticket_id)).toMatchObject({ status: 'closed', org_id: SERVICE_ORG_ID });
  expect((await pools.root.query(`select payload from hdt_ticket_events where ticket_id = $1 and kind = 'status'`, [t.ticket_id])).rows).toEqual([
    { payload: { from: 'new', to: 'closed', reason: 'not_client' } },
  ]);
  expect((await pools.root.query(`select count(*)::int as n from hdn_blocked_senders where address = 'vendor@unknown.uz'`)).rows[0].n).toBe(0);
  // Обращение клиента так закрыть нельзя.
  await expect(markNotClient(staffCtx(f.l1), f.tickets.aOrg.number)).rejects.toMatchObject({ code: 'transition_refused' });
});

test('гость не видит обращений других гостей', async () => {
  const first = await unknownLetter('first@unknown.uz');
  const second = await unknownLetter('second@unknown.uz');
  const guest = { type: 'client', userId: first.author_id, orgId: SERVICE_ORG_ID, orgRole: 'client_user' } as const;
  expect(await sees(guest, first.ticket_id)).toBe(1);
  expect(await sees(guest, second.ticket_id)).toBe(0);
});

test('product не может привязать', async () => {
  const t = await unknownLetter();
  const product = staffCtx(await staffWithRole('product'));
  expect((await listUnidentified(product)).count).toBe(1);
  await expect(bindTicket(product, { number: t.number, orgId: f.orgA.orgId })).rejects.toMatchObject({ code: 'forbidden' });
  await expect(markSpam(product, t.number)).rejects.toMatchObject({ code: 'forbidden' });
  expect(await ticketRow(t.ticket_id)).toMatchObject({ org_id: SERVICE_ORG_ID });
});

test('письмо из "Неопознанных" не попадает в очередь "Новые", у ссылки на очередь свой счётчик', async () => {
  const t = await unknownLetter();
  const l1 = staffCtx(f.l1);
  const fresh = await listQueue(l1, { queue: 'new' });
  expect(fresh.items.map((i) => i.number)).not.toContain(t.number);
  expect((await queueCounts(l1)).new).toBe(fresh.items.length);
  expect(await unidentifiedCount(l1)).toBe(1);
  await bindTicket(l1, { number: t.number, orgId: f.orgA.orgId });
  expect((await listQueue(l1, { queue: 'new' })).items.map((i) => i.number)).toContain(t.number);
  expect(await unidentifiedCount(l1)).toBe(0);
});

test('сотрудник видит отметку "отправитель не подтверждён" и может пригласить отправителя', async () => {
  await pools.root.query(`insert into hdu_org_email_domains (org_id, domain, added_by) values ($1, 'company-a.uz', $2)`, [f.orgA.orgId, f.care.userId]);
  const t = await unknownLetter('Dilnoza <dilnoza@company-a.uz>');
  const view = await getAgentTicket(staffCtx(f.l1), t.number);
  expect(view).toMatchObject({ senderUnconfirmed: true, guestSender: { address: 'dilnoza@company-a.uz' }, author: { email: 'dilnoza@company-a.uz' } });
  expect(await inviteSender(staffCtx(f.l1), t.number)).toEqual({ invited: true });
  expect(await pendingInvitations('dilnoza@company-a.uz')).toEqual([{ org_id: f.orgA.orgId, guest_user_id: t.author_id }]);
  // У обращения из "Неопознанных" приглашать некого, пока оно не привязано.
  const unbound = await unknownLetter('other@unknown.uz');
  expect((await getAgentTicket(staffCtx(f.l1), unbound.number))?.guestSender).toBeNull();
  await expect(inviteSender(staffCtx(f.l1), unbound.number)).rejects.toMatchObject({ code: 'transition_refused' });
});

test('ответ сотрудника, письмо о котором не доставлено: отметка "Письмо не доставлено"', async () => {
  await pools.root.query(`update auth."user" set email = 'a-user@example.uz', "emailVerified" = true where id = $1`, [f.aUser.userId]);
  const l1 = staffCtx(f.l1);
  const number = f.tickets.aOrg.number;
  const before = await getAgentTicket(l1, number);
  await postStaffMessage(l1, { number, body: 'Проверьте, пожалуйста, настройки печати', internal: false, seenVersion: before?.version });
  const outboxRow = (await pools.root.query(`select outbox_id, message_id from hdn_outbox where ticket_id = $1 and template = 'ticket_reply'`, [f.tickets.aOrg.ticketId])).rows[0];
  await pools.root.query(`update hdn_outbox set status = 'sent', external_id = 'prov-1' where outbox_id = $1`, [outboxRow.outbox_id]);
  await recordDelivery({ type: 'system', job: 'email.webhook' }, { kind: 'delivery', emailId: 'prov-1', status: 'bounced', reason: 'mailbox full' });
  const view = await getAgentTicket(l1, number);
  const reply = view?.timeline.find((e) => e.type === 'message' && e.id === outboxRow.message_id);
  expect(reply).toMatchObject({ undelivered: true });
  expect(view?.timeline.filter((e) => e.type === 'message' && e.undelivered)).toHaveLength(1);
});
