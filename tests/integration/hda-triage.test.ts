import { afterEach, beforeEach, expect, test } from 'vitest';
import type { SystemActor } from '@/db/with-actor';
import { runFirstLine } from '@/modules/hda/first-line/run';
import { runTriageJob, runTriageReview } from '@/modules/hda/api/triage-jobs';
import { liftTriageFieldOff, triageBlock } from '@/modules/hda/api/triage';
import { setAiClientForTests, StubAiClient } from '@/modules/hda/testing';
import { MemoryJobQueue, setJobQueueForTests } from '@/modules/hdc/testing';
import { setEmbedderForTests } from '@/modules/hdk/embeddings';
import { createStubEmbedder } from '@/modules/hdk/embeddings/stub';
import { createTicket, createTicketForClient, getTicket } from '@/modules/hdt/api';
import { acceptTriage } from '@/modules/hdt/api/triage';
import { clientCtx, staffCtx, staffWithRole } from './helpers/auth';
import { asActor, pools } from './helpers/db';
import { type Fixture, seedTwoOrgs } from './isolation/fixture';

// Предложения разбора и блок AI у сотрудника (план M5b, задача 7; FR-TRI-01..06, FR-AI-13, решения 6, 18).
// Клиент предложений и резюме не видит; заголовок с телефоном или ссылкой не предлагается; поле обращения не
// меняется без нажатия сотрудника; принятие без права записи отклоняется; ночная задача отключает поле с долей
// принятых ниже 70% при не менее чем 30 решениях.

const SYSTEM: SystemActor = { type: 'system', job: 'ai.first_line' };
const TRIAGE: SystemActor = { type: 'system', job: 'ai.triage' };
let f: Fixture;
let jobs: MemoryJobQueue;
let moduleCode: string;
let moduleId: string;

const SUMMARY = 'Клиент не может напечатать документ.';

beforeEach(async () => {
  f = await seedTwoOrgs();
  jobs = new MemoryJobQueue();
  setJobQueueForTests(jobs);
  setEmbedderForTests(createStubEmbedder());
  setAiClientForTests(new StubAiClient());
  moduleCode = `tri-${Date.now()}-${Math.round(Math.random() * 1e6)}`;
  moduleId = (await pools.root.query(`insert into hdr_product_modules (code, name) values ($1, '{"ru": "Склад"}') returning module_id`, [moduleCode])).rows[0].module_id as string;
  await pools.root.query(`delete from hdk_search_documents`);
  await pools.root.query(`delete from hda_triage_suggestions`);
  await pools.root.query(`delete from hda_triage_field_offs`);
  await pools.root.query(`delete from hda_runs`);
  await pools.root.query(`delete from hdc_rate_limits`);
  await pools.root.query(`delete from hdc_settings where code like 'ai.%'`);
  await pools.root.query(`insert into hdc_settings (code, value) values ('ai.enabled', 'true'::jsonb)`);
});
afterEach(() => {
  setAiClientForTests();
  setJobQueueForTests(null);
  setEmbedderForTests(null);
});

async function ticket(description: string, over: Record<string, unknown> = {}) {
  const { number } = await createTicket(await clientCtx(f.aUser), { description, type: 'question', impact: 'minor', locale: 'ru', ...over });
  const ticketId = (await pools.root.query(`select ticket_id from hdt_tickets where number = $1`, [number])).rows[0].ticket_id as string;
  return { number, ticketId };
}
const suggestions = (ticketId: string) =>
  pools.root.query(`select field, value, status from hda_triage_suggestions where ticket_id = $1 order by field`, [ticketId]).then((r) => r.rows);
const stubWith = (triage: Record<string, unknown>) =>
  new StubAiClient(() => ({
    triage: { moduleCode: null, type: null, title: 'Не печатается накладная', summary: SUMMARY, looksMoreSevere: false, ...triage },
    action: 'handoff',
    solutionId: null,
    introId: 'likely_solution',
    clarifyBetween: null,
    questionIds: [],
    restrictedTopic: false,
    customerAsksHuman: false,
  }));

test('разбор из того же вызова первой линии: предложения записаны, поля обращения не изменены без сотрудника', async () => {
  setAiClientForTests(stubWith({ moduleCode, type: 'bug', looksMoreSevere: true }));
  const { ticketId } = await ticket('Не печатается накладная из заказа, принтер в порядке');
  const before = (await pools.root.query(`select title, type, module_id from hdt_tickets where ticket_id = $1`, [ticketId])).rows[0];
  await runFirstLine(SYSTEM, ticketId);
  expect(await suggestions(ticketId)).toEqual([
    { field: 'module', value: moduleId, status: 'pending' },
    { field: 'priority_hint', value: 'check', status: 'pending' },
    { field: 'summary', value: SUMMARY, status: 'pending' },
    { field: 'title', value: 'Не печатается накладная', status: 'pending' },
    { field: 'type', value: 'bug', status: 'pending' },
  ]);
  // Ровно один вызов модели: разбор и ответ одним вызовом (FR-TRI-05).
  expect((await pools.root.query(`select purpose from hda_runs`)).rows.map((r) => r.purpose)).toEqual(['first_line']);
  expect((await pools.root.query(`select title, type, module_id from hdt_tickets where ticket_id = $1`, [ticketId])).rows[0]).toEqual(before);
});

test('враждебная заглушка: заголовок с телефоном и ссылкой не предлагается, неизвестный модуль тоже', async () => {
  setAiClientForTests(StubAiClient.hostile());
  const { ticketId } = await ticket('Не печатается накладная из заказа, принтер в порядке');
  await runFirstLine(SYSTEM, ticketId);
  const fields = (await suggestions(ticketId)).map((r) => r.field);
  expect(fields).not.toContain('title');
  expect(fields).not.toContain('module');
  // Тип совпал с выбранным клиентом: предлагать нечего.
  expect(fields).toEqual(['summary', 'type']);
});

test('клиент не видит ни предложений, ни резюме: ни в таблице, ни в обращении, ни в письмах (FR-TRI-06)', async () => {
  setAiClientForTests(stubWith({ moduleCode, type: 'bug' }));
  const { number, ticketId } = await ticket('Не печатается накладная из заказа, принтер в порядке');
  await runFirstLine(SYSTEM, ticketId);
  const rows = await asActor(pools.app, f.aUser.actor, (c) => c.query(`select * from hda_triage_suggestions`));
  expect(rows.rowCount).toBe(0);
  await acceptTriage(staffCtx(f.l1), { number, fields: ['title', 'type', 'module', 'summary'] });
  const view = await getTicket(await clientCtx(f.aUser), number);
  expect(JSON.stringify(view)).not.toContain(SUMMARY);
  expect(JSON.stringify(view)).not.toContain('triage');
  const mail = await pools.root.query(`select payload::text as p from hdn_outbox where payload::text like $1`, [`%${SUMMARY}%`]);
  expect(mail.rowCount).toBe(0);
});

test('принятие: поля меняются действием hdt с событием истории и журналом аудита; product не может принять', async () => {
  setAiClientForTests(stubWith({ moduleCode, type: 'bug' }));
  const { number, ticketId } = await ticket('Не печатается накладная из заказа, принтер в порядке');
  await runFirstLine(SYSTEM, ticketId);
  const product = staffCtx(await staffWithRole('product'));
  await expect(acceptTriage(product, { number, fields: ['title'] })).rejects.toMatchObject({ code: 'forbidden' });
  await expect(acceptTriage(staffCtx(f.l1), { number, fields: ['nonsense'] })).rejects.toMatchObject({ code: 'invalid_input' });

  await acceptTriage(staffCtx(f.l1), { number, fields: ['type'] });
  let t = (await pools.root.query(`select title, type, module_id from hdt_tickets where ticket_id = $1`, [ticketId])).rows[0];
  expect(t.type).toBe('bug');
  expect(t.module_id).toBeNull();

  // "Принять всё": одной транзакцией остальные ждущие поля.
  await acceptTriage(staffCtx(f.l1), { number, fields: 'all' });
  t = (await pools.root.query(`select title, type, module_id from hdt_tickets where ticket_id = $1`, [ticketId])).rows[0];
  expect(t).toEqual({ title: 'Не печатается накладная', type: 'bug', module_id: moduleId });
  expect((await suggestions(ticketId)).every((s) => s.status === 'accepted')).toBe(true);
  const events = (await pools.root.query(`select payload, is_internal from hdt_ticket_events where ticket_id = $1 and kind = 'triage_accepted' order by created_on`, [ticketId])).rows;
  expect(events).toHaveLength(2);
  expect(events.every((e) => e.is_internal)).toBe(true);
  expect(events[1].payload).toMatchObject({ fields: { title: { to: 'Не печатается накладная' }, module: { to: moduleId } } });
  const audit = (await pools.root.query(`select actor_id from hdc_audit_log where action = 'ticket.triage_accepted' and object_id = $1`, [ticketId])).rows;
  expect(audit).toHaveLength(2);
  expect(audit[0].actor_id).toBe(f.l1.userId);
  // Повторное принятие ничего не меняет и событий не пишет.
  await acceptTriage(staffCtx(f.l1), { number, fields: 'all' });
  expect((await pools.root.query(`select 1 from hdt_ticket_events where ticket_id = $1 and kind = 'triage_accepted'`, [ticketId])).rowCount).toBe(2);
});

test('блок AI у сотрудника: предложения, найденные решения, резюме; клиенту блок недоступен', async () => {
  setAiClientForTests(stubWith({ moduleCode }));
  const { ticketId } = await ticket('Не печатается накладная из заказа, принтер в порядке');
  await runFirstLine(SYSTEM, ticketId);
  const block = await triageBlock(staffCtx(f.l1), { ticketId });
  expect(block.suggestions.map((s) => s.field).sort()).toEqual(['module', 'summary', 'title']);
  expect(block.found).toEqual([]);
  await expect(triageBlock({ actor: f.aUser.actor } as never, { ticketId })).rejects.toMatchObject({ code: 'forbidden' });
});

test('ai.triage: обращение от сотрудника получает разбор без ответа (решение 6), выключенная AI-обработка ничего', async () => {
  const created = await createTicketForClient(staffCtx(f.l1), { orgId: f.orgA.orgId, authorId: f.aUser.userId, description: 'Клиент позвонил: не печатается накладная', type: 'question', impact: 'minor', visibility: 'org', locale: 'ru' });
  const ticketId = (await pools.root.query(`select ticket_id from hdt_tickets where number = $1`, [created.number])).rows[0].ticket_id as string;
  expect(jobs.sent.filter((j) => j.name === 'ai.triage').map((j) => j.data)).toEqual([{ ticketId }]);
  expect(jobs.sent.some((j) => j.name === 'ai.first_line')).toBe(false);
  const stub = new StubAiClient();
  setAiClientForTests(stub);
  await runTriageJob(TRIAGE, { ticketId });
  expect((await suggestions(ticketId)).map((s) => s.field)).toContain('summary');
  expect((await pools.root.query(`select purpose, ticket_id from hda_runs`)).rows).toEqual([{ purpose: 'triage', ticket_id: ticketId }]);
  // Модель разбора быстрая (решение 1), клиенту ничего не пишется.
  expect(stub.calls[0]!.model).toBe('claude-haiku-5-5');
  expect((await pools.root.query(`select 1 from hdt_ticket_messages where ticket_id = $1 and author_type = 'ai'`, [ticketId])).rowCount).toBe(0);
  // Повтор задания второго разбора не даёт.
  await runTriageJob(TRIAGE, { ticketId });
  expect(stub.calls).toHaveLength(1);

  await pools.root.query(`update hdu_organizations set is_ai_enabled = false where org_id = $1`, [f.orgA.orgId]);
  const off = await createTicketForClient(staffCtx(f.l1), { orgId: f.orgA.orgId, authorId: f.aUser.userId, description: 'Клиент позвонил: не печатается накладная', type: 'question', impact: 'minor', visibility: 'org', locale: 'ru' });
  const offId = (await pools.root.query(`select ticket_id from hdt_tickets where number = $1`, [off.number])).rows[0].ticket_id as string;
  expect(jobs.sent.filter((j) => j.name === 'ai.triage' && j.data.ticketId === offId)).toHaveLength(0);
  await runTriageJob(TRIAGE, { ticketId: offId });
  expect(stub.calls).toHaveLength(1);
});

test('помощник выключен администратором: обращение клиента получает только разбор; разбор выключен: ничего', async () => {
  await pools.root.query(`update hdc_settings set value = 'false'::jsonb where code = 'ai.enabled'`);
  const { ticketId } = await ticket('Не печатается накладная из заказа');
  expect(jobs.sent.filter((j) => j.name === 'ai.triage').map((j) => j.data)).toEqual([{ ticketId }]);
  await pools.root.query(`insert into hdc_settings (code, value) values ('ai.triage_enabled', 'false'::jsonb)`);
  const second = await ticket('Не печатается накладная из заказа снова');
  expect(jobs.sent.filter((j) => j.name === 'ai.triage' && j.data.ticketId === second.ticketId)).toHaveLength(0);
});

test('ai.triage_review: доля принятых ниже 70% при 30 решениях отключает поле, администратор включает обратно (FR-TRI-04)', async () => {
  const run = (await pools.root.query(`insert into hda_runs (org_id, purpose, model, outcome) values ($1, 'first_line', 'stub-model', 'ok') returning run_id`, [f.orgA.orgId])).rows[0].run_id;
  // 30 обращений: заголовок принят у 20 из 30 (67%), у модуля 29 решений: меньше 30, поле не трогается.
  for (let i = 0; i < 30; i++) {
    await pools.root.query(`delete from hdc_rate_limits`);
    const { ticketId } = await ticket(`Обращение номер ${i} про склад`);
    const accepted = i < 20;
    await pools.root.query(
      `insert into hda_triage_suggestions (org_id, ticket_id, run_id, field, value, status, decided_on, decided_by) values ($1, $2, $3, 'title', 'Заголовок', $4, now(), $5)`,
      [f.orgA.orgId, ticketId, run, accepted ? 'accepted' : 'rejected', f.l1.userId],
    );
    if (i < 29)
      await pools.root.query(`insert into hda_triage_suggestions (org_id, ticket_id, run_id, field, value, status, decided_on, decided_by) values ($1, $2, $3, 'module', $4, 'accepted', now(), $5)`, [
        f.orgA.orgId,
        ticketId,
        run,
        moduleId,
        f.l1.userId,
      ]);
  }
  const now = new Date(Date.now() + 1000);
  expect(await runTriageReview({ type: 'system', job: 'ai.triage_review' }, { now })).toEqual(['title']);
  const offs = (await pools.root.query(`select field, decisions, share::float as share from hda_triage_field_offs where lifted_on is null`)).rows;
  expect(offs).toEqual([{ field: 'title', decisions: 30, share: 0.6667 }]);
  // Повтор ночью ничего не добавляет.
  expect(await runTriageReview({ type: 'system', job: 'ai.triage_review' }, { now })).toEqual([]);

  // Отключённое поле больше не предлагается.
  setAiClientForTests(stubWith({ moduleCode }));
  await pools.root.query(`delete from hdc_rate_limits`);
  const fresh = await ticket('Не печатается накладная из заказа, принтер в порядке');
  await runFirstLine(SYSTEM, fresh.ticketId);
  expect((await suggestions(fresh.ticketId)).map((s) => s.field)).toEqual(['module', 'summary']);

  // Включить обратно может только администратор со свежим входом.
  const offId = (await pools.root.query(`select off_id from hda_triage_field_offs`)).rows[0].off_id;
  await expect(liftTriageFieldOff(staffCtx(f.l1), { offId })).rejects.toMatchObject({ code: 'forbidden' });
  await liftTriageFieldOff(staffCtx(f.adminStaff), { offId });
  expect((await pools.root.query(`select 1 from hda_triage_field_offs where lifted_on is null`)).rowCount).toBe(0);
  expect((await pools.root.query(`select 1 from hdc_audit_log where action = 'settings.changed' and object_id = 'ai.triage_field_off'`)).rowCount).toBe(1);
  // В этом месяце ночь поле снова не отключает.
  expect(await runTriageReview({ type: 'system', job: 'ai.triage_review' }, { now })).toEqual([]);
});

test('долг M5b M7: резюме и пометка приоритета не участвуют в правиле 70% (их принятие ничего не меняет в обращении)', async () => {
  const run = (await pools.root.query(`insert into hda_runs (org_id, purpose, model, outcome) values ($1, 'first_line', 'stub-model', 'ok') returning run_id`, [f.orgA.orgId])).rows[0].run_id;
  // 30 решений по резюме и пометке приоритета, ни одно не принято.
  for (let i = 0; i < 30; i++) {
    await pools.root.query(`delete from hdc_rate_limits`);
    const { ticketId } = await ticket(`Обращение про резюме ${i}`);
    await pools.root.query(
      `insert into hda_triage_suggestions (org_id, ticket_id, run_id, field, value, status, decided_on, decided_by) values ($1, $2, $3, 'summary', 'Резюме', 'rejected', now(), $4), ($1, $2, $3, 'priority_hint', 'check', 'rejected', now(), $4)`,
      [f.orgA.orgId, ticketId, run, f.l1.userId],
    );
  }
  expect(await runTriageReview({ type: 'system', job: 'ai.triage_review' }, { now: new Date(Date.now() + 1000) })).toEqual([]);
  expect((await pools.root.query(`select field from hda_triage_field_offs`)).rows).toEqual([]);
});
