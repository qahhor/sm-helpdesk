import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { createStubScanner } from '@/modules/hdc/antivirus/stub';
import { MemoryJobQueue, MemoryStorage, setJobQueueForTests, setScannerForTests, setStorageForTests } from '@/modules/hdc/testing';
import { handleEmailWebhook } from '@/modules/hdn/api/webhook-email';
import { replyAddress } from '@/modules/hdn/inbound/reply-address';
import { createMemoryEmailProvider, type MemoryEmailProvider, setEmailProviderForTests, setInboundAuthservForTests, setReplyConfigForTests } from '@/modules/hdn/testing';
import { scanAttachment } from '@/modules/hdt/api/jobs';
import { intakeEmail } from '@/modules/hdt/api/email-intake';
import { asActor, pools } from './helpers/db';
import { type Fixture, seedTwoOrgs } from './isolation/fixture';

// Ответ на письмо попадает в то же обращение (FR-NT-05..08, FR-EM-02, FR-EM-08; раздел 11.8; решения 16 и 20 вехи M4).

const SYSTEM = { type: 'system', job: 'email.inbound' } as const;
const REPLY = { domain: 'reply.example.test', secret: 'reply-secret-of-at-least-32-chars!!' };
const AUTHSERV = 'inbound.example.test';
const EICAR = 'X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*';
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...new Array(24).fill(1)]);

let provider: MemoryEmailProvider;
let storage: MemoryStorage;
let jobs: MemoryJobQueue;
let f: Fixture;

beforeEach(async () => {
  provider = createMemoryEmailProvider();
  setEmailProviderForTests(provider);
  setReplyConfigForTests(REPLY);
  setInboundAuthservForTests(AUTHSERV);
  storage = new MemoryStorage();
  setStorageForTests(storage);
  setScannerForTests(createStubScanner());
  jobs = new MemoryJobQueue();
  setJobQueueForTests(jobs);
  f = await seedTwoOrgs();
  await pools.root.query(`update auth."user" set email = 'a-user@example.uz', "emailVerified" = true where id = $1`, [f.aUser.userId]);
});
afterEach(() => {
  setEmailProviderForTests(null);
  setReplyConfigForTests(undefined);
  setInboundAuthservForTests(undefined);
  setStorageForTests(null);
  setScannerForTests(null);
  setJobQueueForTests(null);
});

type Letter = {
  from?: string;
  to?: string[];
  subject?: string;
  text?: string;
  html?: string | null;
  messageId?: string;
  headers?: [string, string][];
  dmarc?: 'pass' | 'fail' | null;
  attachments?: { filename: string; contentType: string; data: Uint8Array; inline?: boolean }[];
};

/** Письмо приходит вебхуком, затем его разбирает задача email.inbound. */
async function deliver(letter: Letter): Promise<{ inboundId: string; result: string }> {
  const emailId = randomUUID();
  const from = letter.from ?? 'Anvar <a-user@example.uz>';
  const domain = (from.match(/@([^>]+)/)?.[1] ?? '').toLowerCase();
  const auth: [string, string][] =
    letter.dmarc === null ? [] : [['Authentication-Results', `${AUTHSERV}; dmarc=${letter.dmarc ?? 'pass'} header.from=${domain}`]];
  provider.inbound(
    emailId,
    { html: letter.html ?? null, text: letter.text ?? 'Спасибо, заработало', headers: [...auth, ...(letter.headers ?? [])] },
    (letter.attachments ?? []).map((a, i) => ({
      id: `att-${i}`,
      filename: a.filename,
      contentType: a.contentType,
      size: a.data.byteLength,
      contentId: a.inline ? `cid-${i}` : null,
      disposition: a.inline ? 'inline' : 'attachment',
      downloadUrl: `https://inbound.test/${emailId}/${i}`,
      data: a.data,
    })),
  );
  const signed = provider.signedRequest({
    type: 'email.received',
    created_at: new Date().toISOString(),
    data: { email_id: emailId, from, to: letter.to ?? ['support@reply.example.test'], cc: [], subject: letter.subject ?? 'Re: письмо', message_id: letter.messageId ?? `<${emailId}@mail.example.uz>` },
  });
  const response = await handleEmailWebhook(new Request('http://localhost:3000/api/webhooks/email', { method: 'POST', body: signed.body, headers: signed.headers }));
  expect(response.status).toBe(200);
  const inboundId = (await pools.root.query(`select inbound_id from hdn_email_inbound where provider_id = $1`, [emailId])).rows[0].inbound_id as string;
  return { inboundId, result: await intakeEmail(SYSTEM, inboundId) };
}

const signedTo = (number: number, userId: string) => replyAddress(number, userId, REPLY);
const messages = (ticketId: string) =>
  pools.root
    .query(`select author_id, author_type, body, is_internal, source, email_message_id, is_thanks from hdt_ticket_messages where ticket_id = $1 and source = 'email' or (ticket_id = $1 and author_type = 'system' and is_internal) order by created_on`, [ticketId])
    .then((r) => r.rows);
const ticketCount = () => pools.root.query(`select count(*)::int as n from hdt_tickets`).then((r) => r.rows[0].n as number);

test('ответ на подписанный адрес: сообщение клиента в том же обращении, цитата отрезана', async () => {
  const t = f.tickets.aOrg;
  const { result } = await deliver({
    to: [signedTo(t.number, f.aUser.userId)],
    text: 'Спасибо, заработало\n\nOn Mon, Nov 23, 2026 at 10:00 AM Smartup Hub <hub@mail.smartup24.com> wrote:\n> Проверьте настройки',
  });
  expect(result).toBe('reply');
  const rows = await messages(t.ticketId);
  expect(rows).toEqual([expect.objectContaining({ author_id: f.aUser.userId, author_type: 'client', body: 'Спасибо, заработало', is_internal: false, source: 'email' })]);
  expect(rows[0].email_message_id).toMatch(/@mail\.example\.uz>$/);
  // Клиент видит своё сообщение в портале.
  const seen = await asActor(pools.app, f.aUser.actor, (c) => c.query(`select count(*)::int as n from hdt_ticket_messages where ticket_id = $1 and source = 'email'`, [t.ticketId]));
  expect(seen.rows[0].n).toBe(1);
  expect((await pools.root.query(`select direction from hdn_email_threads where ticket_id = $1 and direction = 'in'`, [t.ticketId])).rows).toHaveLength(1);
});

test('неверная подпись адреса: письмо отброшено, обращения нет', async () => {
  const t = f.tickets.aOrg;
  const before = await ticketCount();
  const bad = signedTo(t.number, f.aUser.userId).replace(/\.([0-9a-f])([0-9a-f]{19})@/, (_m, c: string, rest: string) => `.${c === '0' ? '1' : '0'}${rest}@`);
  const { result } = await deliver({ to: [bad] });
  expect(result).toBe('ignored');
  expect(await messages(t.ticketId)).toEqual([]);
  expect(await ticketCount()).toBe(before);
});

test('ответ с другого адреса: внутренняя заметка, клиенту не видна, письма нет', async () => {
  const t = f.tickets.aOrg;
  const { result } = await deliver({ from: 'Someone <someone@other.uz>', to: [signedTo(t.number, f.aUser.userId)], text: 'Пересылаю вам' });
  expect(result).toBe('review');
  const rows = await messages(t.ticketId);
  expect(rows).toEqual([expect.objectContaining({ author_type: 'system', is_internal: true })]);
  expect(rows[0].body).toContain('someone@other.uz');
  expect(rows[0].body).toContain('Пересылаю вам');
  const seen = await asActor(pools.app, f.aUser.actor, (c) => c.query(`select count(*)::int as n from hdt_ticket_messages where ticket_id = $1 and author_type = 'system' and is_internal`, [t.ticketId]));
  expect(seen.rows[0].n).toBe(0);
  expect((await pools.root.query(`select count(*)::int as n from hdn_outbox where ticket_id = $1 and status = 'queued'`, [t.ticketId])).rows[0].n).toBe(0);
});

test('ответ без DMARC с верного адреса: на проверку', async () => {
  const t = f.tickets.aOrg;
  expect((await deliver({ to: [signedTo(t.number, f.aUser.userId)], dmarc: 'fail' })).result).toBe('review');
  expect((await deliver({ to: [signedTo(t.number, f.aUser.userId)], dmarc: null })).result).toBe('review');
});

test('пользователя исключили из организации: на проверку', async () => {
  const t = f.tickets.aOrg;
  await pools.root.query(`update hdu_memberships set state = 'passive' where user_id = $1 and org_id = $2`, [f.aUser.userId, f.orgA.orgId]);
  expect((await deliver({ to: [signedTo(t.number, f.aUser.userId)] })).result).toBe('review');
});

test('In-Reply-To нашего письма относит к обращению', async () => {
  const t = f.tickets.aOrg;
  await pools.root.query(`insert into hdn_email_threads (ticket_id, message_id, direction) values ($1, '<our-letter-1@reply.example.test>', 'out')`, [t.ticketId]);
  const { result } = await deliver({ headers: [['In-Reply-To', '<our-letter-1@reply.example.test>']], subject: 'Re: что-то' });
  expect(result).toBe('reply');
  expect((await messages(t.ticketId)).map((m) => m.author_id)).toEqual([f.aUser.userId]);
});

test('номер в теме от участника относит, от чужого создаёт новое', async () => {
  const t = f.tickets.aOrg;
  expect((await deliver({ subject: `Re: [SUP-${t.number}] Отчёт` })).result).toBe('reply');
  expect((await messages(t.ticketId)).map((m) => m.author_id)).toEqual([f.aUser.userId]);
  const before = await ticketCount();
  expect((await deliver({ from: 'Stranger <stranger@other.uz>', subject: `Re: [SUP-${t.number}] Отчёт` })).result).toBe('new');
  expect(await messages(t.ticketId)).toHaveLength(1);
  expect(await ticketCount()).toBe(before + 1);
});

test('повторная доставка письма сообщение не дублирует', async () => {
  const t = f.tickets.aOrg;
  const letter = { to: [signedTo(t.number, f.aUser.userId)], messageId: '<same-letter@mail.example.uz>' };
  await deliver(letter);
  await deliver(letter);
  expect(await messages(t.ticketId)).toHaveLength(1);
  // Повтор той же задачи разбора ничего не делает.
  const { inboundId } = await deliver({ ...letter, messageId: '<another@mail.example.uz>' });
  expect(await intakeEmail(SYSTEM, inboundId)).toBe('reply');
  expect(await messages(t.ticketId)).toHaveLength(2);
});

test('автоответ на наше письмо: сохранён, обращения и ответа нет', async () => {
  const t = f.tickets.aOrg;
  const before = await ticketCount();
  const { result, inboundId } = await deliver({ to: [signedTo(t.number, f.aUser.userId)], subject: 'Автоответ: Re: [SUP-1]', headers: [['Auto-Submitted', 'auto-replied']] });
  expect(result).toBe('auto');
  expect(await messages(t.ticketId)).toEqual([]);
  expect(await ticketCount()).toBe(before);
  expect((await pools.root.query(`select classification from hdn_email_inbound where inbound_id = $1`, [inboundId])).rows[0].classification).toBe('auto');
});

test('вложение с вирусом: заражено, ссылки нет; картинка тела письма стала вложением', async () => {
  const t = f.tickets.aOrg;
  await deliver({
    to: [signedTo(t.number, f.aUser.userId)],
    attachments: [
      { filename: 'readme.txt', contentType: 'text/plain', data: new TextEncoder().encode(EICAR) },
      { filename: 'screen.png', contentType: 'image/png', data: PNG, inline: true },
    ],
  });
  const rows = (await pools.root.query(`select attachment_id, file_name, scan_status, uploader_id, message_id from hdt_attachments where ticket_id = $1 and uploader_id = $2 and message_id is not null order by file_name`, [t.ticketId, f.aUser.userId])).rows;
  expect(rows.map((r) => [r.file_name, r.scan_status])).toEqual([
    ['readme.txt', 'pending'],
    ['screen.png', 'pending'],
  ]);
  expect(rows.every((r) => r.message_id)).toBe(true);
  expect(jobs.sent.filter((j) => j.name === 'attachment.scan').map((j) => j.data.attachmentId).sort()).toEqual(rows.map((r) => r.attachment_id).sort());
  for (const row of rows) await scanAttachment({ type: 'system', job: 'attachment.scan' }, row.attachment_id);
  const after = (await pools.root.query(`select file_name, scan_status from hdt_attachments where ticket_id = $1 and uploader_id = $2 and message_id is not null order by file_name`, [t.ticketId, f.aUser.userId])).rows;
  expect(after).toEqual([
    { file_name: 'readme.txt', scan_status: 'infected' },
    { file_name: 'screen.png', scan_status: 'clean' },
  ]);
});

test('ответ на решённое "Спасибо!" не открывает обращение', async () => {
  const t = f.tickets.aOrg;
  await pools.root.query(`update hdt_tickets set status = 'resolved', resolved_on = now(), resolution_type = 'solved' where ticket_id = $1`, [t.ticketId]);
  await deliver({ to: [signedTo(t.number, f.aUser.userId)], text: 'Спасибо!' });
  expect((await pools.root.query(`select status from hdt_tickets where ticket_id = $1`, [t.ticketId])).rows[0].status).toBe('resolved');
  expect((await messages(t.ticketId)).map((m) => m.is_thanks)).toEqual([true]);
  // Ответ с вопросом открывает обращение.
  await deliver({ to: [signedTo(t.number, f.aUser.userId)], text: 'А почему снова не работает?' });
  expect((await pools.root.query(`select status from hdt_tickets where ticket_id = $1`, [t.ticketId])).rows[0].status).toBe('in_progress');
});
