import { beforeEach, expect, test } from 'vitest';
import { requeueStaleInbound } from '@/modules/hdn/api/inbound';
import { dispatchOutbox } from '@/modules/hdn/api/outbox';
import { applyGuestMerges, bindTicket, createTicket, getAgentTicket, listUnidentified, markSpam, postStaffMessage, ticketsMinute } from '@/modules/hdt/api';
import { acceptInvitation, completeLoginLink, inviteMember, requestLoginLink } from '@/modules/hdu/api';
import { clientCtx, newJar, noRequest, staffCtx, verifiedClientFixture } from './helpers/auth';
import { pools } from './helpers/db';
import { replyAddress } from '@/modules/hdn/inbound/reply-address';
import { deliver as deliverTo, inboundPerTest, type Letter, receive, REPLY } from './helpers/inbound';
import { memoryMailerPerTest, tokenFrom } from './helpers/mail';
import { type Fixture, seedTwoOrgs } from './isolation/fixture';

// Исправления по итоговой проверке ветки M4 (важные замечания I1-I11). Каждый тест сначала падал.

const OUTBOX = { type: 'system', job: 'outbox.dispatch' } as const;
const MINUTE_JOB = { type: 'system', job: 'tickets.minute' } as const;

const box = inboundPerTest();
const mail = memoryMailerPerTest();
let f: Fixture;

beforeEach(async () => {
  f = await seedTwoOrgs();
  await pools.root.query(`update auth."user" set email = 'a-user@example.uz', "emailVerified" = true, "lastOrgId" = $2 where id = $1`, [f.aUser.userId, f.orgA.orgId]);
});

const deliver = (letter: Letter & { brokenAttachments?: boolean }) => deliverTo(box, letter);
const ticketOf = async (inboundId: string) =>
  (
    await pools.root.query(
      `select t.ticket_id, t.number, t.org_id, t.author_id, t.description, t.sender_unconfirmed from hdn_email_inbound i join hdt_tickets t on t.ticket_id = i.ticket_id where i.inbound_id = $1`,
      [inboundId],
    )
  ).rows[0] as { ticket_id: string; number: string; org_id: string; author_id: string; description: string; sender_unconfirmed: boolean };
/** created_on ставит база (app.stamp_row): в прошлое строку переносит суперпользователь с выключенными триггерами. */
async function backdate(table: string, key: string, ids: string[], interval: string): Promise<void> {
  const list = ids.map((id) => `'${id.replace(/[^0-9a-f-]/g, '')}'`).join(', ');
  await pools.root.query(`set session_replication_role = replica; update ${table} set created_on = now() - interval '${interval}' where ${key} in (${list}); set session_replication_role = origin`);
}
const authorOf = async (ticketId: string) => (await pools.root.query(`select author_id from hdt_tickets where ticket_id = $1`, [ticketId])).rows[0].author_id as string;

/** Вход по ссылке на подтверждённый адрес: сессия для принятия приглашения существующей учётной записью. */
async function signedIn(email: string) {
  const jar = newJar();
  const before = mail.mailer.sent.length;
  await requestLoginLink({ email, locale: 'ru' }, noRequest);
  expect(await completeLoginLink({ token: tokenFrom(mail.mailer.sent[before]), locale: 'ru' }, jar.request)).toMatchObject({ ok: true });
  return jar;
}

// --- I1: письма не теряются ---

test('I1: непрочитанное письмо старше 10 минут снова ставится в разбор, свежее и разобранное нет', async () => {
  const stale = await receive(box, { from: 'one@unknown.uz', subject: 'Застряло' });
  const fresh = await receive(box, { from: 'two@unknown.uz', subject: 'Только что' });
  const done = await deliver({ from: 'three@unknown.uz', subject: 'Разобрано' });
  await backdate('hdn_email_inbound', 'inbound_id', [stale.inboundId, done.inboundId], '15 minutes');
  box.jobs.sent.splice(0);
  expect(await requeueStaleInbound({ type: 'system', job: 'email.sweep' }, new Date())).toBe(1);
  expect(box.jobs.sent.filter((j) => j.name === 'email.inbound').map((j) => j.data.inboundId)).toEqual([stale.inboundId]);
  void fresh;
});

test('I1: адрес в домене .рф (punycode) и адрес с редкими знаками принимаются, обращение создаётся', async () => {
  expect((await deliver({ from: 'Иван <ivan@company.xn--p1ai>', subject: 'Домен рф' })).result).toBe('new');
  expect((await deliver({ from: 'o=rders!x@shop.uz', subject: 'Знаки' })).result).toBe('new');
});

test('I1: сбой списка вложений и короткий Message-ID не губят письмо', async () => {
  expect((await deliver({ from: 'files@unknown.uz', subject: 'Без списка', brokenAttachments: true })).result).toBe('new');
  expect((await deliver({ from: 'short@unknown.uz', subject: 'Короткий', messageId: '<>' })).result).toBe('new');
});

// --- I2: пересланное письмо не теряется ---

test('I2: новое обращение из пересланного письма содержит пересланный текст', async () => {
  const { inboundId } = await deliver({
    from: 'fwd@unknown.uz',
    subject: 'Fwd: Ошибка выгрузки',
    text: 'Посмотрите ниже\n\n---------- Forwarded message ---------\nFrom: Supplier <s@vendor.uz>\nDate: Mon\n\nОшибка 500 при выгрузке остатков',
  });
  expect((await ticketOf(inboundId)).description).toContain('Ошибка 500 при выгрузке остатков');
});

// --- I3: цепочка по нашему Message-ID ---

test('I3: Message-ID нашего письма записывается при отправке, ответ с In-Reply-To попадает в обращение', async () => {
  const { number } = await createTicket(await clientCtx(f.aUser), { description: 'Не печатается накладная', type: 'bug', impact: 'minor', locale: 'ru' });
  await dispatchOutbox(OUTBOX, new Date());
  const sent = box.provider.sent.find((s) => s.message.to === 'a-user@example.uz');
  const messageId = sent?.message.headers?.['Message-ID'] as string;
  expect(messageId).toMatch(/^<.+@reply\.example\.test>$/);
  const ticketId = (await pools.root.query(`select ticket_id from hdt_tickets where number = $1`, [number])).rows[0].ticket_id;
  expect((await pools.root.query(`select direction from hdn_email_threads where message_id = $1 and ticket_id = $2`, [messageId, ticketId])).rows).toEqual([{ direction: 'out' }]);
  const { result, inboundId } = await deliver({ subject: 'Re: что-то', headers: [['In-Reply-To', messageId]], text: 'Вот снимок экрана' });
  expect(result).toBe('reply');
  expect((await pools.root.query(`select ticket_id from hdn_email_inbound where inbound_id = $1`, [inboundId])).rows[0].ticket_id).toBe(ticketId);
});

// --- I5, I6: переход гостя ---

test('I5: подделанное письмо с адреса клиента не становится его обращением, когда он принимает другое приглашение', async () => {
  await pools.root.query(`update auth."user" set email = 'b-user@example.uz', "emailVerified" = true where id = $1`, [f.bUser.userId]);
  const forged = await ticketOf((await deliver({ from: 'b-user@example.uz', subject: 'Подделка', dmarc: 'fail' })).inboundId);
  expect(forged.author_id).not.toBe(f.bUser.userId);
  // Сотрудник видит, что адрес принадлежит клиенту портала: возможна подделка.
  expect((await listUnidentified(staffCtx(f.l1))).items.find((i) => i.number === Number(forged.number))).toMatchObject({ fromAddress: 'b-user@example.uz', addressOwned: true });
  await inviteMember({ ctx: await clientCtx(f.aAdmin) }, { email: 'b-user@example.uz', role: 'client_user', locale: 'ru' });
  const invitation = tokenFrom(mail.mailer.sent.at(-1));
  expect(await acceptInvitation({ token: invitation }, (await signedIn('b-user@example.uz')).request)).toEqual({ ok: true });
  await applyGuestMerges(MINUTE_JOB);
  expect(await authorOf(forged.ticket_id)).toBe(forged.author_id);
});

test('I5, I6: после перехода обращения гостя помечены "отправитель не подтверждён"; письмо после перехода тоже переходит при новом приглашении', async () => {
  const first = await ticketOf((await deliver({ from: 'Бобур <bobur@unknown.uz>', subject: 'Первое' })).inboundId);
  await bindTicket(staffCtx(f.l1), { number: Number(first.number), orgId: f.orgA.orgId });
  expect(await acceptInvitation({ token: tokenFrom(mail.mailer.sent.at(-1)), name: 'Бобур' }, noRequest)).toEqual({ ok: true });
  await applyGuestMerges(MINUTE_JOB);
  const user = (await pools.root.query(`select id from auth."user" where email = 'bobur@unknown.uz'`)).rows[0].id as string;
  expect(await authorOf(first.ticket_id)).toBe(user);
  expect((await getAgentTicket(staffCtx(f.l1), Number(first.number)))?.senderUnconfirmed).toBe(true);
  // Следующее письмо без DMARC снова от гостя; привязка и приглашение переводят и его.
  const second = await ticketOf((await deliver({ from: 'bobur@unknown.uz', subject: 'Второе', dmarc: 'fail' })).inboundId);
  expect(second.author_id).toBe(first.author_id);
  await bindTicket(staffCtx(f.l1), { number: Number(second.number), orgId: f.orgA.orgId });
  expect(await acceptInvitation({ token: tokenFrom(mail.mailer.sent.at(-1)) }, (await signedIn('bobur@unknown.uz')).request)).toEqual({ ok: true });
  await applyGuestMerges(MINUTE_JOB);
  expect(await authorOf(second.ticket_id)).toBe(user);
});

// --- I7: спам и предел не задевают настоящего клиента ---

test('I7: адрес в спаме и десять подделок в час не мешают письмам настоящего клиента с DMARC', async () => {
  const forged = await ticketOf((await deliver({ subject: 'Реклама', dmarc: 'fail' })).inboundId);
  await markSpam(staffCtx(f.l1), Number(forged.number));
  expect((await deliver({ subject: 'Ещё реклама', dmarc: 'fail' })).result).toBe('spam');
  expect((await deliver({ subject: 'Настоящий вопрос' })).result).toBe('new');
  await pools.root.query(`delete from hdn_blocked_senders`);
  for (let i = 0; i < 10; i++) await deliver({ subject: `Подделка ${i}`, dmarc: 'fail' });
  expect((await deliver({ subject: 'Подделка 11', dmarc: 'fail' })).result).toBe('rate_limited');
  expect((await deliver({ subject: 'Настоящий вопрос 2' })).result).toBe('new');
});

// --- I8: письма только тем, кто видит обращение ---

test('I8: отключённый участник и подписчик личного обращения писем об ответе сотрудника не получают', async () => {
  const colleague = await verifiedClientFixture('colleague@example.uz', { orgId: f.orgA.orgId });
  const t = f.tickets.aOrg;
  await pools.root.query(`update auth."user" set email = 'a-admin@example.uz', "emailVerified" = true where id = $1`, [f.aAdmin.userId]);
  await pools.root.query(`insert into hdt_ticket_watchers (org_id, ticket_id, user_id, source) values ($1, $2, $3, 'manual'), ($1, $2, $4, 'manual') on conflict do nothing`, [
    f.orgA.orgId,
    t.ticketId,
    f.aAdmin.userId,
    colleague.userId,
  ]);
  await pools.root.query(`update hdu_memberships set state = 'passive' where user_id = $1 and org_id = $2`, [f.aAdmin.userId, f.orgA.orgId]);
  const l1 = staffCtx(f.l1);
  await postStaffMessage(l1, { number: t.number, body: 'Первый ответ', internal: false, seenVersion: (await getAgentTicket(l1, t.number))?.version });
  const recipients = async () =>
    (await pools.root.query(`select recipient_user_id from hdn_outbox where ticket_id = $1 and template = 'ticket_reply'`, [t.ticketId])).rows.map((r) => r.recipient_user_id).sort();
  expect(await recipients()).toEqual([f.aUser.userId, colleague.userId].sort());
  await pools.root.query(`delete from hdn_outbox`);
  await pools.root.query(`update hdt_tickets set visibility = 'private' where ticket_id = $1`, [t.ticketId]);
  await postStaffMessage(l1, { number: t.number, body: 'Второй ответ', internal: false, seenVersion: (await getAgentTicket(l1, t.number))?.version });
  expect(await recipients()).toEqual([f.aUser.userId]);
});

// --- I9: напоминание об обновлении не застревает на первых 200 ---

test('I9: напоминание о регулярном обновлении доходит до обращения за первыми двумястами', async () => {
  await pools.root.query(
    `insert into hdt_tickets (org_id, author_id, type, impact, priority, visibility, title, description, locale, source, status, assignee_id)
     select $1, $2, 'bug', 'minor', 'p3', 'org', 'Свежее ' || g, 'Свежее', 'ru', 'portal', 'in_development', $3 from generate_series(1, 205) g`,
    [f.orgA.orgId, f.aUser.userId, f.l1.userId],
  );
  // Давнее обращение создаётся последним: по идентификатору оно за первыми двумястами.
  const old = (
    await pools.root.query(
      `insert into hdt_tickets (org_id, author_id, type, impact, priority, visibility, title, description, locale, source, status, assignee_id)
       values ($1, $2, 'bug', 'minor', 'p3', 'org', 'Давнее', 'Давнее', 'ru', 'portal', 'in_development', $3) returning ticket_id`,
      [f.orgA.orgId, f.aUser.userId, f.l1.userId],
    )
  ).rows[0].ticket_id as string;
  await backdate('hdt_tickets', 'ticket_id', [old], '20 days');
  await ticketsMinute(MINUTE_JOB, new Date());
  expect((await pools.root.query(`select update_reminded_on from hdt_tickets where ticket_id = $1`, [old])).rows[0].update_reminded_on).not.toBeNull();
});

// --- I10: журнал аудита гостевых членств и смены автора ---

test('I10: гостевое членство в организации и смена автора при переходе гостя пишутся в журнал', async () => {
  await pools.root.query(`insert into hdu_org_email_domains (org_id, domain, added_by) values ($1, 'company-a.uz', $2)`, [f.orgA.orgId, f.care.userId]);
  const byDomain = await ticketOf((await deliver({ from: 'Dilnoza <dilnoza@company-a.uz>', subject: 'По домену' })).inboundId);
  const joined = await pools.root.query(`select diff from hdc_audit_log where action = 'member.joined' and object_id = $1 and org_id = $2`, [byDomain.author_id, f.orgA.orgId]);
  expect(joined.rows).toEqual([{ diff: { role: 'client_user', source: 'guest' } }]);
  const t = await ticketOf((await deliver({ from: 'bobur@unknown.uz', subject: 'Гость' })).inboundId);
  await bindTicket(staffCtx(f.l1), { number: Number(t.number), orgId: f.orgB.orgId });
  expect((await pools.root.query(`select 1 from hdc_audit_log where action = 'member.joined' and object_id = $1 and org_id = $2`, [t.author_id, f.orgB.orgId])).rows).toHaveLength(1);
  await acceptInvitation({ token: tokenFrom(mail.mailer.sent.at(-1)), name: 'Бобур' }, noRequest);
  await applyGuestMerges(MINUTE_JOB);
  const moved = await pools.root.query(`select diff from hdc_audit_log where action = 'ticket.author_moved' and object_id = $1`, [t.ticket_id]);
  expect(moved.rows).toEqual([{ diff: { from: t.author_id, to: await authorOf(t.ticket_id) } }]);
});

// --- I11: предел заметок "Письмо на проверке" ---

test('I11: больше 20 писем на проверку в час с адреса сохраняются как rate_limited без заметки', async () => {
  const t = f.tickets.aOrg;
  const to = [replyAddress(t.number, f.aUser.userId, REPLY)];
  for (let i = 0; i < 20; i++) {
    // Предел на обращение (5 в час, аудит 23.11.2026, S12) здесь снят: проверяется предел на адрес отправителя.
    await pools.root.query(`delete from hdc_rate_limits where code like 'email-review:ticket:%'`);
    expect((await deliver({ from: 'someone@other.uz', to, text: `Письмо ${i}` })).result).toBe('review');
  }
  await pools.root.query(`delete from hdc_rate_limits where code like 'email-review:ticket:%'`);
  expect((await deliver({ from: 'someone@other.uz', to, text: 'Письмо 21' })).result).toBe('rate_limited');
  const notes = await pools.root.query(`select count(*)::int as n from hdt_ticket_messages where ticket_id = $1 and author_type = 'system' and is_internal`, [t.ticketId]);
  expect(notes.rows[0].n).toBe(20);
});

// --- Аудит 23.11.2026, находка S12: заметки "Письмо на проверке" в чужом обращении ---

test('S12: в одно обращение не больше 5 заметок на проверку в час, даже с разных адресов', async () => {
  const t = f.tickets.aOrg;
  const to = [replyAddress(t.number, f.aUser.userId, REPLY)];
  for (let i = 0; i < 5; i++) expect((await deliver({ from: `sender${i}@other.uz`, to, text: `Письмо ${i}` })).result).toBe('review');
  expect((await deliver({ from: 'sender6@other.uz', to, text: 'Письмо 6' })).result).toBe('rate_limited');
  const notes = await pools.root.query(`select count(*)::int as n from hdt_ticket_messages where ticket_id = $1 and author_type = 'system' and is_internal`, [t.ticketId]);
  expect(notes.rows[0].n).toBe(5);
});

test('S12: ссылки из письма на проверке в заметку не попадают, узел остаётся виден', async () => {
  const t = f.tickets.aOrg;
  const to = [replyAddress(t.number, f.aUser.userId, REPLY)];
  const text = 'Срочно войдите: https://hub-smartup.evil.example/login?next=1 и ещё http://203.0.113.7:8080/x, а также www.evil.example/pay. Спасибо.';
  expect((await deliver({ from: 'someone@other.uz', to, text })).result).toBe('review');
  const body = (await pools.root.query(`select body from hdt_ticket_messages where ticket_id = $1 and author_type = 'system' and is_internal`, [t.ticketId])).rows[0].body as string;
  expect(body).not.toMatch(/https?:\/\//);
  expect(body).not.toContain('www.evil.example/pay');
  expect(body).not.toContain('/login?next=1');
  expect(body).toContain('[ссылка убрана: hub-smartup.evil.example]');
  expect(body).toContain('[ссылка убрана: 203.0.113.7]');
  expect(body).toContain('[ссылка убрана: www.evil.example]');
  expect(body).toContain('Срочно войдите:');
  expect(body).toContain('Спасибо.');
});
