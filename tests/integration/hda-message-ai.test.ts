import { afterEach, beforeEach, expect, test } from 'vitest';
import type { SystemActor } from '@/db/with-actor';
import { cleanupMessageTranslations, messageTranslations, requestMessageTranslation, runMessageTranslationJob, runThanksJob } from '@/modules/hda/api/message-ai';
import { setAiClientForTests, StubAiClient } from '@/modules/hda/testing';
import { MemoryJobQueue, setJobQueueForTests } from '@/modules/hdc/testing';
import { getTicket, listThanks, replyToTicket } from '@/modules/hdt/api';
import { clientCtx, staffCtx, staffWithRole } from './helpers/auth';
import { asActor, pools } from './helpers/db';
import { type Fixture, seedTwoOrgs } from './isolation/fixture';

// Перевод сообщения клиента и благодарность с AI (план M5b, задача 9; FR-AG-11, FR-TK-14, решение 24). Перевод виден
// только сотруднику и не попадает в переписку; в модель уходит только текст одного сообщения клиента после очистки;
// организация с выключенной AI-обработкой перевода не получает; строки старше 24 часов удаляются; модель может только
// открыть обращение заново, но не оставить решённым то, что код счёл сомнением.

const SYSTEM: SystemActor = { type: 'system', job: 'ai.message_translation' };
const THANKS: SystemActor = { type: 'system', job: 'ai.thanks' };
let f: Fixture;
let jobs: MemoryJobQueue;
let stub: StubAiClient;

beforeEach(async () => {
  f = await seedTwoOrgs();
  jobs = new MemoryJobQueue();
  setJobQueueForTests(jobs);
  stub = new StubAiClient();
  setAiClientForTests(stub);
  await pools.root.query(`delete from hda_message_translations`);
  await pools.root.query(`delete from hda_runs`);
  await pools.root.query(`delete from hdc_rate_limits`);
  await pools.root.query(`delete from hdc_settings where code like 'ai.%'`);
});
afterEach(() => {
  setAiClientForTests();
  setJobQueueForTests(null);
});

const ticket = () => f.tickets.aOrg;
async function clientMessage(body: string): Promise<string> {
  return (
    await pools.root.query(`insert into hdt_ticket_messages (org_id, ticket_id, author_id, author_type, body) values ($1, $2, $3, 'client', $4) returning message_id`, [
      f.orgA.orgId,
      ticket().ticketId,
      f.aUser.userId,
      body,
    ])
  ).rows[0].message_id as string;
}

test('перевод: только сотруднику, в модель уходит только текст одного сообщения клиента после очистки', async () => {
  const author = (await pools.root.query(`select email, name from auth."user" where id = $1`, [f.aUser.userId])).rows[0];
  await clientMessage('ДРУГОЕ-СООБЩЕНИЕ-КЛИЕНТА');
  await pools.root.query(`insert into hdt_ticket_messages (org_id, ticket_id, author_id, author_type, body, is_internal) values ($1, $2, $3, 'staff', 'ЗАМЕТКА-СЕКРЕТ', true)`, [f.orgA.orgId, ticket().ticketId, f.l1.userId]);
  const messageId = await clientMessage(`Hisobot ochilmayapti. ${author.name}, ${author.email}, +998 90 123 45 67`);
  const { translationId } = await requestMessageTranslation(staffCtx(f.l1), { messageId, locale: 'ru' });
  expect(jobs.sent.filter((j) => j.name === 'ai.message_translation').map((j) => j.data)).toEqual([{ translationId }]);
  expect((await messageTranslations(staffCtx(f.l1), { ticketId: ticket().ticketId, orgId: f.orgA.orgId })).items).toEqual([{ messageId, locale: 'ru', status: 'pending', text: null }]);

  await runMessageTranslationJob(SYSTEM, { translationId });
  const sent = stub.calls[0]!;
  expect(sent.data).toContain('Hisobot ochilmayapti');
  for (const forbidden of ['ДРУГОЕ-СООБЩЕНИЕ-КЛИЕНТА', 'ЗАМЕТКА-СЕКРЕТ', ticket().title, author.email, author.name, '123 45 67', f.orgA.name]) expect(sent.data, forbidden).not.toContain(forbidden);
  expect(sent.model).toBe('claude-haiku-5-5');
  const [item] = (await messageTranslations(staffCtx(f.l1), { ticketId: ticket().ticketId, orgId: f.orgA.orgId })).items;
  expect(item).toMatchObject({ messageId, locale: 'ru', status: 'ready' });
  expect(item!.text).toContain('Hisobot ochilmayapti');

  // Клиент не видит ни строки перевода, ни перевода в обращении; в переписку перевод не попал.
  expect((await asActor(pools.app, f.aUser.actor, (c) => c.query(`select * from hda_message_translations`))).rowCount).toBe(0);
  const messages = (await pools.root.query(`select count(*)::int as n from hdt_ticket_messages where ticket_id = $1 and body like '%Hisobot%'`, [ticket().ticketId])).rows[0].n;
  expect(messages).toBe(1);
  expect(JSON.stringify(await getTicket(await clientCtx(f.aUser), ticket().number))).not.toContain('машинный');
  await expect(messageTranslations({ actor: f.aUser.actor } as never, { ticketId: ticket().ticketId, orgId: f.orgA.orgId })).rejects.toMatchObject({ code: 'forbidden' });
});

test('перевод: выключенная AI-обработка, заметка, сообщение сотрудника и product отклоняются', async () => {
  const messageId = await clientMessage('Отчёт не открывается');
  await expect(requestMessageTranslation(staffCtx(await staffWithRole('product')), { messageId, locale: 'ru' })).rejects.toMatchObject({ code: 'forbidden' });
  const note = (await pools.root.query(`insert into hdt_ticket_messages (org_id, ticket_id, author_id, author_type, body, is_internal) values ($1, $2, $3, 'staff', 'Заметка', true) returning message_id`, [f.orgA.orgId, ticket().ticketId, f.l1.userId])).rows[0].message_id;
  await expect(requestMessageTranslation(staffCtx(f.l1), { messageId: note, locale: 'ru' })).rejects.toMatchObject({ code: 'invalid_input' });
  await pools.root.query(`update hdu_organizations set is_ai_enabled = false where org_id = $1`, [f.orgA.orgId]);
  await expect(requestMessageTranslation(staffCtx(f.l1), { messageId, locale: 'ru' })).rejects.toMatchObject({ code: 'forbidden' });
  expect((await messageTranslations(staffCtx(f.l1), { ticketId: ticket().ticketId, orgId: f.orgA.orgId })).aiAllowed).toBe(false);
  expect(jobs.sent.filter((j) => j.name === 'ai.message_translation')).toHaveLength(0);
});

test('переводы старше 24 часов удаляются', async () => {
  const messageId = await clientMessage('Отчёт не открывается');
  const { translationId } = await requestMessageTranslation(staffCtx(f.l1), { messageId, locale: 'en' });
  await runMessageTranslationJob(SYSTEM, { translationId });
  const fresh = await clientMessage('Склад не открывается');
  await requestMessageTranslation(staffCtx(f.l1), { messageId: fresh, locale: 'en' });
  await pools.root.query(`begin; set local session_replication_role = replica; update hda_message_translations set created_on = now() - interval '25 hours' where translation_id = '${translationId}'; commit`);
  expect(await cleanupMessageTranslations({ type: 'system', job: 'ai.budget' })).toBe(1);
  expect((await pools.root.query(`select message_id from hda_message_translations`)).rows.map((r) => r.message_id)).toEqual([fresh]);
});

async function resolvedTicket() {
  await pools.root.query(`update hdt_tickets set status = 'resolved', resolved_on = now(), resolution_type = 'solved' where ticket_id = $1`, [ticket().ticketId]);
}
const status = () => pools.root.query(`select status from hdt_tickets where ticket_id = $1`, [ticket().ticketId]).then((r) => r.rows[0].status as string);

test('благодарность: код счёл "спасибо", модель ответила "не благодарность" - обращение открыто заново с историей и журналом', async () => {
  await resolvedTicket();
  await replyToTicket(await clientCtx(f.aUser), { number: ticket().number, body: 'Спасибо, всё работает' });
  expect(await status()).toBe('resolved');
  const job = jobs.sent.find((j) => j.name === 'ai.thanks');
  expect(job).toBeDefined();
  setAiClientForTests((stub = new StubAiClient(() => ({ thanks: false }))));
  expect(await runThanksJob(THANKS, job!.data)).toBe('reopened');
  expect(stub.calls[0]!.data).toContain('Спасибо, всё работает');
  expect(stub.calls[0]!.data).not.toContain(ticket().title);
  expect(await status()).toBe('in_progress');
  const event = (await pools.root.query(`select actor_type, payload, is_internal from hdt_ticket_events where ticket_id = $1 and kind = 'status' order by created_on desc limit 1`, [ticket().ticketId])).rows[0];
  expect(event).toMatchObject({ actor_type: 'system', payload: { from: 'resolved', to: 'in_progress', reason: 'ai_thanks', messageId: job!.data.messageId } });
  expect((await pools.root.query(`select 1 from hdc_audit_log where action = 'ticket.status_changed' and object_id = $1 and diff ->> 'reason' = 'ai_thanks'`, [ticket().ticketId])).rowCount).toBe(1);
  // Переписка не меняется, но в списке "Не открыли обращение" этого сообщения больше нет.
  expect((await listThanks(staffCtx(f.l1), { page: 1 })).items.map((i) => i.number)).not.toContain(ticket().number);
  // Повтор задания ничего не меняет.
  expect(await runThanksJob(THANKS, job!.data)).toBe('skipped');
});

test('благодарность: модель подтвердила - обращение остаётся решённым; сомнение кода открывает без модели', async () => {
  await resolvedTicket();
  await replyToTicket(await clientCtx(f.aUser), { number: ticket().number, body: 'Рахмат, ишлади' });
  setAiClientForTests((stub = new StubAiClient(() => ({ thanks: true }))));
  expect(await runThanksJob(THANKS, jobs.sent.find((j) => j.name === 'ai.thanks')!.data)).toBe('kept');
  expect(await status()).toBe('resolved');

  // Код счёл сообщение сомнением: обращение открыто сразу, модель не спрашивается и помешать не может.
  jobs.sent.length = 0;
  await replyToTicket(await clientCtx(f.aUser), { number: ticket().number, body: 'Спасибо, но ошибка снова' });
  expect(await status()).toBe('in_progress');
  expect(jobs.sent.filter((j) => j.name === 'ai.thanks')).toHaveLength(0);
});

test('благодарность: организация с выключенной AI-обработкой модель не спрашивает', async () => {
  await resolvedTicket();
  await pools.root.query(`update hdu_organizations set is_ai_enabled = false where org_id = $1`, [f.orgA.orgId]);
  await replyToTicket(await clientCtx(f.aUser), { number: ticket().number, body: 'Спасибо большое' });
  expect(jobs.sent.filter((j) => j.name === 'ai.thanks')).toHaveLength(0);
  expect(await status()).toBe('resolved');
});

// Независимая проверка M5b, находка I5: один клиент не расходует общий суточный предел ответами "спасибо".
test('благодарность: не больше одного вопроса модели на обращение в сутки и пределы пользователя и организации', async () => {
  await resolvedTicket();
  setAiClientForTests((stub = new StubAiClient(() => ({ thanks: true }))));
  const ctx = await clientCtx(f.aUser);
  for (const body of ['Спасибо', 'Спасибо большое', 'Рахмат']) await replyToTicket(ctx, { number: ticket().number, body });
  const sent = jobs.sent.filter((j) => j.name === 'ai.thanks');
  expect(sent).toHaveLength(3);
  const results: string[] = [];
  for (const job of sent) results.push(await runThanksJob(THANKS, job.data));
  expect(results).toEqual(['kept', 'skipped', 'skipped']);
  expect(stub.calls).toHaveLength(1);
  expect(await status()).toBe('resolved');
  // Предел пользователя на сутки исчерпан: модель не вызывается и для другого обращения, строка журнала "limited".
  await pools.root.query(`insert into hdc_settings (code, value) values ('ai.user_daily_limit', '1'::jsonb)`);
  const other = f.tickets.aMine;
  await pools.root.query(`update hdt_tickets set status = 'resolved', resolved_on = now(), resolution_type = 'solved' where ticket_id = $1`, [other.ticketId]);
  jobs.sent.length = 0;
  await replyToTicket(ctx, { number: other.number, body: 'Спасибо' });
  expect(await runThanksJob(THANKS, jobs.sent.find((j) => j.name === 'ai.thanks')!.data)).toBe('kept');
  expect(stub.calls).toHaveLength(1);
  expect((await pools.root.query(`select outcome from hda_runs where purpose = 'thanks' order by created_on`)).rows.map((r) => r.outcome)).toEqual(['ok', 'limited']);
});

test('перевод сообщения считается в пределе пользователя', async () => {
  await pools.root.query(`insert into hdc_settings (code, value) values ('ai.user_daily_limit', '0'::jsonb)`);
  const messageId = await clientMessage('Не печатается накладная');
  const { translationId } = await requestMessageTranslation(staffCtx(f.l1), { messageId, locale: 'en' });
  expect(await runMessageTranslationJob(SYSTEM, { translationId })).toBe('failed');
  expect(stub.calls).toHaveLength(0);
  expect((await pools.root.query(`select outcome from hda_runs where purpose = 'message_translation'`)).rows.map((r) => r.outcome)).toEqual(['limited']);
});
