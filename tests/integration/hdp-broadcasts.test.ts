import { afterEach, beforeEach, expect, test } from 'vitest';
import { setAiClientForTests, StubAiClient } from '@/modules/hda/testing';
import { MemoryJobQueue, setJobQueueForTests } from '@/modules/hdc/testing';
import { broadcastDraft, confirmBroadcast, listBroadcasts, prepareBroadcast } from '@/modules/hdp/api/broadcasts';
import { runBroadcastJob, runBroadcastTranslationJob, setBroadcastHookForTests, stuckBroadcastCount, sweepBroadcasts } from '@/modules/hdp/api/broadcast-jobs';
import { linkTicketToProblem } from '@/modules/hdp/api/links';
import { createProblem, saveProblemTranslation, setProblemShown } from '@/modules/hdp/api/problems';
import { collectOpsAlerts } from '@/worker/ops-watch';
import { staffCtx, staffWithRole } from './helpers/auth';
import { memoryBotPerTest } from './helpers/telegram';
import { asActor, pools, system } from './helpers/db';
import { type Fixture, seedTwoOrgs } from './isolation/fixture';

// Рассылка обновления и закрытие известной проблемы (ТЗ FR-KP-06, 07, 11.14, FR-NT-12, 14, T23; строка M5c 16.2
// "повторный запуск рассылки не создаёт дублей"; план M5c, задача 5, решения 17-21).

let f: Fixture;
let l2: ReturnType<typeof staffCtx>;
let jobs: MemoryJobQueue;
let problem: number;
memoryBotPerTest();

beforeEach(async () => {
  f = await seedTwoOrgs();
  l2 = staffCtx(await staffWithRole('agent_l2'));
  jobs = new MemoryJobQueue();
  setJobQueueForTests(jobs);
  setAiClientForTests(new StubAiClient());
  ({ number: problem } = await createProblem(l2, { internalTitle: 'Накладные' }));
  await saveProblemTranslation(l2, { number: problem, locale: 'ru', publicTitle: 'Не проводятся накладные', publicBody: 'Исправляем.' });
  await setProblemShown(l2, { number: problem, shown: true });
  // Получатели: новое (ru), ждёт клиента (ru) у организации А, в работе (uz) у Б. Закрытое и объединённое не получат.
  await pools.root.query(`update hdt_tickets set status = 'waiting_customer', client_waiting_since = null where ticket_id = $1`, [f.tickets.aMine.ticketId]);
  await pools.root.query(`update hdt_tickets set status = 'in_progress', locale = 'uz', client_waiting_since = now() where ticket_id = $1`, [f.tickets.bOrg.ticketId]);
  for (const t of [f.tickets.aOrg, f.tickets.aMine, f.tickets.bOrg, f.tickets.aPrivate]) await linkTicketToProblem(l2, { ticketNumber: t.number, problemNumber: problem });
  await pools.root.query(`update hdt_tickets set status = 'closed', closed_on = now() where ticket_id = $1`, [f.tickets.aPrivate.ticketId]);
});
afterEach(() => {
  setJobQueueForTests(null);
  setAiClientForTests();
  setBroadcastHookForTests(null);
});

const UPDATE = 'Нашли причину. Исправление выйдет в версии 5.12.4.';
const messages = (broadcastId: string) =>
  pools.root.query(`select ticket_id, author_id, author_type, body, is_internal from hdt_ticket_messages where broadcast_id = $1 order by ticket_id`, [broadcastId]).then((r) => r.rows);
const mails = (template: string) =>
  pools.root.query(`select ticket_id, recipient_user_id, channel, payload from hdn_outbox where template = $1 order by ticket_id, channel`, [template]).then((r) => r.rows);
const ticket = (ticketId: string) => pools.root.query(`select * from hdt_tickets where ticket_id = $1`, [ticketId]).then((r) => r.rows[0]);

async function confirmed(kind: 'update' | 'closing' = 'update', body = UPDATE): Promise<string> {
  const { broadcastId } = await prepareBroadcast(l2, { number: problem, kind, body, locale: 'ru' });
  await confirmBroadcast(l2, { broadcastId, translations: { uz: 'Sababini topdik. Tuzatish 5.12.4 versiyasida chiqadi.' }, fallbackToOriginal: false });
  return broadcastId;
}

test('подготовка: число обращений, организаций и языки получателей; подтверждение без перевода и с находкой отклоняется', async () => {
  const prepared = await prepareBroadcast(l2, { number: problem, kind: 'update', body: UPDATE, locale: 'ru' });
  expect(prepared).toMatchObject({ recipients: 3, orgs: 2, locales: ['ru', 'uz'] });
  // Машинный перевод готовит задача; до принятия сотрудником клиенту он не уходит.
  const job = jobs.sent.find((j) => j.name === 'problems.translate' && j.data.broadcastId === prepared.broadcastId);
  expect(job?.data).toMatchObject({ broadcastId: prepared.broadcastId, locale: 'uz' });
  await runBroadcastTranslationJob(system, job!.data);
  expect((await broadcastDraft(l2, prepared.broadcastId))?.machine).toEqual({ uz: UPDATE });
  await expect(confirmBroadcast(l2, { broadcastId: prepared.broadcastId, translations: {}, fallbackToOriginal: false })).rejects.toMatchObject({ code: 'translation_required' });
  await expect(confirmBroadcast(l2, { broadcastId: prepared.broadcastId, translations: { uz: 'Qo‘ng‘iroq qiling +998 90 123-45-67' }, fallbackToOriginal: false })).rejects.toMatchObject({ code: 'text_findings' });
  // Название организации получателя в тексте: отказ на подготовке (T23).
  await expect(prepareBroadcast(l2, { number: problem, kind: 'update', body: 'У Globex всё исправлено', locale: 'ru' })).rejects.toMatchObject({ code: 'text_findings' });
  // Первая линия рассылку не делает.
  await expect(prepareBroadcast(staffCtx(f.l1), { number: problem, kind: 'update', body: UPDATE, locale: 'ru' })).rejects.toMatchObject({ code: 'forbidden' });
  // Без подтверждения ничего не отправлено.
  await runBroadcastJob(system, { broadcastId: prepared.broadcastId });
  expect(await messages(prepared.broadcastId)).toEqual([]);
});

test('рассылка: по одному сообщению и письму каждому получателю даже при повторе и двух задачах одновременно', async () => {
  // Telegram привязан у автора обращений А: ему уходит и сообщение бота (FR-NT-14).
  await pools.root.query(`insert into hdu_contact_identities (user_id, kind, external_id, display_name, verified, verified_on) values ($1, 'telegram', '777101', '@a', 'linked', now())`, [f.aUser.userId]);
  const broadcastId = await confirmed();
  // Обращение, привязанное после подтверждения, рассылку не получает.
  await linkTicketToProblem(l2, { ticketNumber: f.tickets.bPrivate.number, problemNumber: problem });
  await Promise.all([runBroadcastJob(system, { broadcastId }), runBroadcastJob(system, { broadcastId })]);
  await runBroadcastJob(system, { broadcastId });
  const sent = await messages(broadcastId);
  expect(sent.map((m) => m.ticket_id).sort()).toEqual([f.tickets.aOrg.ticketId, f.tickets.aMine.ticketId, f.tickets.bOrg.ticketId].sort());
  for (const m of sent) expect(m).toMatchObject({ author_id: l2.user.id, author_type: 'staff', is_internal: false });
  // Сообщение собрано только из текста рассылки на языке обращения (T23): у Б узбекский текст, без данных А.
  expect(sent.find((m) => m.ticket_id === f.tickets.bOrg.ticketId)?.body).toBe('Sababini topdik. Tuzatish 5.12.4 versiyasida chiqadi.');
  expect(sent.find((m) => m.ticket_id === f.tickets.aOrg.ticketId)?.body).toBe(UPDATE);
  for (const m of sent) expect(m.body).not.toMatch(/ACME|Globex|Отчёт А|Секрет Б/);
  const letters = (await mails('problem_update')).filter((m) => m.channel === 'email');
  // Письмо автору каждого обращения: одно на получателя и обращение.
  const keys = letters.map((m) => `${m.ticket_id}:${m.recipient_user_id}`);
  expect(new Set(keys).size).toBe(keys.length);
  expect(new Set(letters.map((m) => m.ticket_id))).toEqual(new Set([f.tickets.aOrg.ticketId, f.tickets.aMine.ticketId, f.tickets.bOrg.ticketId]));
  expect(letters[0]!.payload).toMatchObject({ template: 'problem_update', problemRef: `KP-${problem}` });
  // Сообщение бота уходит только тем, у кого Telegram привязан и включён: автору обращений А, не автору Б.
  const bot = (await mails('problem_update')).filter((m) => m.channel === 'telegram');
  expect(new Set(bot.map((m) => m.recipient_user_id))).toEqual(new Set([f.aUser.userId]));
  const [row] = await listBroadcasts(l2, problem);
  expect(row).toMatchObject({ broadcastId, kind: 'update', status: 'done', recipientsCount: 3, orgCount: 2, deliveredCount: 3 });
});

test('сбой на одном получателе: остальные получают сразу, рассылка остаётся незавершённой, повтор доставляет без дублей', async () => {
  const broadcastId = await confirmed();
  let calls = 0;
  setBroadcastHookForTests(() => {
    calls += 1;
    if (calls === 2) throw new Error('сбой посреди рассылки');
  });
  // Отказ одного обращения не отнимает сообщение у остальных (проверка качества, Q1): двое из трёх получили.
  await expect(runBroadcastJob(system, { broadcastId })).rejects.toThrow('сбой посреди рассылки');
  expect(calls).toBe(3);
  expect(await messages(broadcastId)).toHaveLength(2);
  expect((await pools.root.query(`select status from hdp_broadcasts where broadcast_id = $1`, [broadcastId])).rows[0].status).toBe('sending');
  setBroadcastHookForTests(null);
  await runBroadcastJob(system, { broadcastId });
  expect(await messages(broadcastId)).toHaveLength(3);
  expect((await pools.root.query(`select status, delivered_count from hdp_broadcasts where broadcast_id = $1`, [broadcastId])).rows[0]).toEqual({ status: 'done', delivered_count: 3 });
  const first = (await messages(broadcastId))[0]!.ticket_id;
  const firstLetters = (await mails('problem_update')).filter((m) => m.channel === 'email' && m.ticket_id === first);
  expect(new Set(firstLetters.map((m) => m.recipient_user_id)).size).toBe(firstLetters.length);
});

test('обход: подтверждённая рассылка без задачи ставится снова через 10 минут, через 30 минут идёт сигнал дежурным', async () => {
  const broadcastId = await confirmed();
  const now = new Date();
  // Свежая рассылка: её задача ещё может идти, обход не трогает.
  jobs.sent.length = 0;
  expect(await sweepBroadcasts(system, now)).toEqual({ requeued: 0 });
  expect(await stuckBroadcastCount(system, now)).toBe(0);
  // Постановка задачи потерялась (сбой между транзакцией подтверждения и очередью): рассылка висит queued.
  // Подтверждённую рассылку триггер менять не даёт: сдвигается время обхода.
  const later = (minutes: number) => new Date(now.getTime() + minutes * 60_000);
  expect(await sweepBroadcasts(system, later(11))).toEqual({ requeued: 1 });
  expect(jobs.sent.filter((j) => j.name === 'problems.broadcast').map((j) => j.data)).toEqual([{ broadcastId }]);
  expect(await stuckBroadcastCount(system, later(11))).toBe(0);
  expect(await stuckBroadcastCount(system, later(31))).toBe(1);
  expect((await collectOpsAlerts(system, later(31), { searchWriter: null })).filter((a) => a.code === 'broadcast_stuck')).toEqual([{ code: 'broadcast_stuck', count: 1 }]);
  // Доставленная рассылка и черновик не считаются.
  await runBroadcastJob(system, { broadcastId });
  expect(await sweepBroadcasts(system, later(31))).toEqual({ requeued: 0 });
  expect(await stuckBroadcastCount(system, later(31))).toBe(0);
});

test('сообщение рассылки останавливает срок первого ответа и снимает "клиент ждёт", исполнитель и статус прежние', async () => {
  const before = await ticket(f.tickets.bOrg.ticketId);
  const broadcastId = await confirmed();
  await runBroadcastJob(system, { broadcastId });
  const after = await ticket(f.tickets.bOrg.ticketId);
  expect(after.first_responded_on).not.toBeNull();
  expect(after.client_waiting_since).toBeNull();
  expect(after).toMatchObject({ status: before.status, assignee_id: before.assignee_id, queue: before.queue });
  // Обращение, закрытое во время рассылки, сообщения не получает.
  const second = await confirmed('update', 'Ещё одно обновление.');
  await pools.root.query(`update hdt_tickets set status = 'closed', closed_on = now() where ticket_id = $1`, [f.tickets.aMine.ticketId]);
  await runBroadcastJob(system, { broadcastId: second });
  expect((await messages(second)).map((m) => m.ticket_id)).not.toContain(f.tickets.aMine.ticketId);
});

test('закрытие: итоговое сообщение и переход в "Решено" разрешёнными переходами с журналом; закрытое и объединённое не трогаются', async () => {
  await pools.root.query(`update hdt_tickets set merged_into_id = $2 where ticket_id = $1`, [f.tickets.aMine.ticketId, f.tickets.aOrg.ticketId]);
  const { broadcastId } = await prepareBroadcast(l2, { number: problem, kind: 'closing', body: 'Исправлено в версии 5.12.4.', locale: 'ru' });
  await confirmBroadcast(l2, { broadcastId, translations: { uz: '5.12.4 versiyada tuzatildi.' }, fallbackToOriginal: false });
  // Проблема закрыта в транзакции подтверждения, сигнатуры не активны.
  expect((await pools.root.query(`select status from hdp_problems where number = $1`, [problem])).rows[0].status).toBe('closed');
  await runBroadcastJob(system, { broadcastId });
  const fresh = await ticket(f.tickets.aOrg.ticketId);
  expect(fresh).toMatchObject({ status: 'resolved', resolution_type: 'solved' });
  // "Новое" прошло через "В работе": два события статуса.
  const statusEvents = (await pools.root.query(`select payload from hdt_ticket_events where ticket_id = $1 and kind = 'status' order by event_id`, [f.tickets.aOrg.ticketId])).rows.map((r) => `${r.payload.from}>${r.payload.to}`);
  expect(statusEvents).toEqual(['new>in_progress', 'in_progress>resolved']);
  expect((await ticket(f.tickets.bOrg.ticketId)).status).toBe('resolved');
  expect((await pools.root.query(`select count(*)::int as n from hdc_audit_log where action = 'ticket.status_changed' and object_id = $1`, [f.tickets.aOrg.ticketId])).rows[0].n).toBe(2);
  // Объединённое и закрытое не получили ни сообщения, ни перехода.
  expect((await messages(broadcastId)).map((m) => m.ticket_id).sort()).toEqual([f.tickets.aOrg.ticketId, f.tickets.bOrg.ticketId].sort());
  expect((await ticket(f.tickets.aMine.ticketId)).status).toBe('waiting_customer');
  expect((await ticket(f.tickets.aPrivate.ticketId)).status).toBe('closed');
});

test('рассылки текстом на языке оригинала одним флажком; клиент не читает рассылок', async () => {
  const { broadcastId } = await prepareBroadcast(l2, { number: problem, kind: 'update', body: UPDATE, locale: 'ru' });
  await confirmBroadcast(l2, { broadcastId, translations: {}, fallbackToOriginal: true });
  await runBroadcastJob(system, { broadcastId });
  expect((await messages(broadcastId)).find((m) => m.ticket_id === f.tickets.bOrg.ticketId)?.body).toBe(UPDATE);
  for (const actor of [f.aUser.actor, f.bAdmin.actor]) expect((await asActor(pools.app, actor, (c) => c.query(`select 1 from hdp_broadcasts`))).rows).toEqual([]);
});

test('закрытие без открытых привязанных обращений закрывает проблему с журналом; обновление без получателей отклоняется', async () => {
  const { number: empty } = await createProblem(l2, { internalTitle: 'Пустая проблема' });
  const update = await prepareBroadcast(l2, { number: empty, kind: 'update', body: UPDATE, locale: 'ru' });
  expect(update.recipients).toBe(0);
  await expect(confirmBroadcast(l2, { broadcastId: update.broadcastId, translations: {}, fallbackToOriginal: false })).rejects.toMatchObject({ code: 'no_recipients' });
  const { broadcastId } = await prepareBroadcast(l2, { number: empty, kind: 'closing', body: 'Исправлено в версии 5.12.4.', locale: 'ru' });
  await expect(confirmBroadcast(l2, { broadcastId, translations: {}, fallbackToOriginal: false })).resolves.toEqual({ recipients: 0 });
  const row = (await pools.root.query(`select problem_id, status, fixed_on from hdp_problems where number = $1`, [empty])).rows[0];
  expect(row.status).toBe('closed');
  const audit = (await pools.root.query(`select diff from hdc_audit_log where action = 'problem.status_changed' and object_id = $1`, [row.problem_id])).rows;
  expect(audit.map((a) => a.diff.to)).toContain('closed');
  await runBroadcastJob(system, { broadcastId });
  expect(await messages(broadcastId)).toEqual([]);
  const [history] = await listBroadcasts(l2, empty);
  expect(history).toMatchObject({ broadcastId, kind: 'closing', status: 'done', recipientsCount: 0 });
});
