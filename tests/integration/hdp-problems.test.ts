import { afterEach, beforeEach, expect, test } from 'vitest';
import { setAiClientForTests, StubAiClient } from '@/modules/hda/testing';
import { MemoryJobQueue, setJobQueueForTests } from '@/modules/hdc/testing';
import {
  addProblemSignature,
  createProblem,
  createProblemFromTicket,
  listProblems,
  problemCard,
  removeProblemSignature,
  requestProblemTranslation,
  saveProblem,
  saveProblemTranslation,
  setProblemShown,
  setProblemStatus,
} from '@/modules/hdp/api/problems';
import { createProblemDraft, runProblemTranslationJob } from '@/modules/hdp/api/translate-jobs';
import { staffCtx, staffWithRole } from './helpers/auth';
import { asActor, pools, system } from './helpers/db';
import { type Fixture, seedTwoOrgs } from './isolation/fixture';

// Ведение известной проблемы сотрудником (ТЗ 7.15, FR-KP-01..03, 10, FR-ADM-12; план M5c, задача 2, решения 3-6, 17).

let f: Fixture;
let l2: ReturnType<typeof staffCtx>;
let jobs: MemoryJobQueue;
let stub: StubAiClient;

const SIG = 'd'.repeat(32);

beforeEach(async () => {
  f = await seedTwoOrgs();
  l2 = staffCtx(await staffWithRole('agent_l2'));
  jobs = new MemoryJobQueue();
  setJobQueueForTests(jobs);
  stub = new StubAiClient();
  setAiClientForTests(stub);
  await pools.root.query(`insert into hdc_settings (code, value) values ('kb.allowed_domains', '["smartup.uz"]') on conflict (code) do update set value = excluded.value`);
});
afterEach(() => {
  setJobQueueForTests(null);
  setAiClientForTests();
});

const problemRow = (number: number) => pools.root.query(`select * from hdp_problems where number = $1`, [number]).then((r) => r.rows[0]);
const texts = (number: number) =>
  pools.root.query(`select t.locale, t.public_title, t.public_body, t.is_machine, t.accepted_by from hdp_problem_translations t join hdp_problems p using (problem_id) where p.number = $1 order by t.locale`, [number]).then((r) => r.rows);
const audit = (prefix: string) => pools.root.query(`select action, actor_id, object_id, diff from hdc_audit_log where action like $1 order by created_on, audit_id`, [`${prefix}%`]).then((r) => r.rows);
const clientSees = () => asActor(pools.app, f.aUser.actor, (c) => c.query(`select number, locale, public_title from hdp_problems_public`)).then((r) => r.rows);

test('создание из обращения: название, модуль, сигнатура и первое появление переносятся, обращение привязано, публичные поля пусты', async () => {
  const moduleId = (await pools.root.query(`insert into hdr_product_modules (code, name) values ('warehouse', '{"ru": "Склад"}') returning module_id`)).rows[0].module_id;
  const t = f.tickets.bOrg;
  await pools.root.query(`update hdt_tickets set module_id = $2, error_signature = $3 where ticket_id = $1`, [t.ticketId, moduleId, SIG]);
  const { number } = await createProblemFromTicket(l2, { ticketNumber: t.number });

  const row = await problemRow(number);
  const created = (await pools.root.query(`select created_on from hdt_tickets where ticket_id = $1`, [t.ticketId])).rows[0].created_on;
  expect(row).toMatchObject({ internal_title: t.title, module_id: moduleId, owner_id: l2.user.id, status: 'investigating', show_to_clients: false, ticket_count: 1, org_count: 1 });
  expect(row.first_seen_on).toEqual(created);
  // Публичного текста нет: текст клиента не уходит другим клиентам (T23).
  expect(await texts(number)).toEqual([]);
  expect((await pools.root.query(`select signature, is_active from hdp_problem_signatures where problem_id = $1`, [row.problem_id])).rows).toEqual([{ signature: SIG, is_active: true }]);
  expect((await pools.root.query(`select known_problem_id from hdt_tickets where ticket_id = $1`, [t.ticketId])).rows[0].known_problem_id).toBe(row.problem_id);
  // История обращения: внутреннее событие; журнал аудита той же транзакцией.
  expect((await pools.root.query(`select payload, is_internal from hdt_ticket_events where ticket_id = $1 and kind = 'known_problem'`, [t.ticketId])).rows).toEqual([
    { payload: { action: 'linked', problemNumber: number, via: 'created' }, is_internal: true },
  ]);
  expect((await audit('problem.created')).map((a) => a.diff)).toEqual([{ number, fromTicket: t.number }]);
  expect((await audit('ticket.problem_linked')).map((a) => a.object_id)).toEqual([t.ticketId]);
  // Обращение уже привязано: вторую проблему из него не создать.
  await expect(createProblemFromTicket(l2, { ticketNumber: t.number })).rejects.toMatchObject({ code: 'already_linked' });
});

test('первая линия и product не создают проблему и не меняют статус; care и admin могут', async () => {
  const l1 = staffCtx(f.l1);
  const product = staffCtx(await staffWithRole('product'));
  for (const ctx of [l1, product]) {
    await expect(createProblem(ctx, { internalTitle: 'Проблема' })).rejects.toMatchObject({ code: 'forbidden' });
    await expect(createProblemFromTicket(ctx, { ticketNumber: f.tickets.aOrg.number })).rejects.toMatchObject({ code: 'forbidden' });
  }
  const { number } = await createProblem(staffCtx(f.care), { internalTitle: 'Отчёт остатков пустой' });
  for (const ctx of [l1, product]) await expect(setProblemStatus(ctx, { number, status: 'fixing' })).rejects.toMatchObject({ code: 'forbidden' });
  await setProblemStatus(staffCtx(f.adminStaff), { number, status: 'fixing' });
  expect((await problemRow(number)).status).toBe('fixing');
  // Читают проблему все сотрудники.
  expect((await problemCard(product, number))?.internalTitle).toBe('Отчёт остатков пустой');
  expect((await listProblems(l1, {})).map((p) => p.number)).toEqual([number]);
});

test('каждая смена статуса и признака показа пишет журнал аудита; закрыть карточкой нельзя', async () => {
  const { number } = await createProblem(l2, { internalTitle: 'Накладные' });
  await setProblemStatus(l2, { number, status: 'cause_found' });
  await setProblemStatus(l2, { number, status: 'fixed' });
  expect((await audit('problem.status_changed')).map((a) => a.diff)).toEqual([
    { number, from: 'investigating', to: 'cause_found' },
    { number, from: 'cause_found', to: 'fixed' },
  ]);
  // Закрытие идёт только окном закрытия с итоговым текстом (решение 20).
  await expect(setProblemStatus(l2, { number, status: 'closed' })).rejects.toMatchObject({ code: 'invalid_input' });
  await saveProblemTranslation(l2, { number, locale: 'ru', publicTitle: 'Не проводятся накладные', publicBody: 'Исправляем ошибку.' });
  await setProblemShown(l2, { number, shown: true });
  await setProblemShown(l2, { number, shown: false });
  expect((await audit('problem.shown_changed')).map((a) => a.diff)).toEqual([
    { number, shown: true },
    { number, shown: false },
  ]);
});

test('признак показа без публичного текста отклоняется; текст с находкой не сохраняется', async () => {
  const { number } = await createProblem(l2, { internalTitle: 'Накладные' });
  await expect(setProblemShown(l2, { number, shown: true })).rejects.toMatchObject({ code: 'public_text_required' });
  await expect(saveProblemTranslation(l2, { number, locale: 'ru', publicTitle: 'Не проводятся накладные', publicBody: 'Звоните +998 90 123-45-67' })).rejects.toMatchObject({ code: 'text_findings' });
  await expect(saveProblemTranslation(l2, { number, locale: 'ru', publicTitle: 'Ошибка', publicBody: 'Подробнее https://evil.example/x' })).rejects.toMatchObject({ code: 'text_findings' });
  expect(await texts(number)).toEqual([]);
  // Только название без описания: показать нельзя.
  await saveProblemTranslation(l2, { number, locale: 'ru', publicTitle: 'Не проводятся накладные', publicBody: '' });
  await expect(setProblemShown(l2, { number, shown: true })).rejects.toMatchObject({ code: 'public_text_required' });
  expect((await problemRow(number)).show_to_clients).toBe(false);
});

test('название и ИНН организации привязанного обращения в публичном тексте дают находку', async () => {
  await pools.root.query(`update hdu_organizations set inn = '301234567' where org_id = $1`, [f.orgA.orgId]);
  const { number } = await createProblemFromTicket(l2, { ticketNumber: f.tickets.aOrg.number });
  await expect(saveProblemTranslation(l2, { number, locale: 'ru', publicTitle: 'Ошибка', publicBody: 'У ACME Trade не проводятся накладные' })).rejects.toMatchObject({
    code: 'text_findings',
    findings: [{ kind: 'org', text: 'ACME Trade' }],
  });
  await expect(saveProblemTranslation(l2, { number, locale: 'ru', publicTitle: 'Ошибка 301234567', publicBody: 'Текст' })).rejects.toMatchObject({ code: 'text_findings' });
  // Без названия клиента текст проходит, проблема показывается клиентам.
  await saveProblemTranslation(l2, { number, locale: 'ru', publicTitle: 'Не проводятся накладные', publicBody: 'После обновления накладные не проводятся.' });
  await setProblemShown(l2, { number, shown: true });
  expect(await clientSees()).toEqual([{ number: String(number), locale: 'ru', public_title: 'Не проводятся накладные' }]);
});

test('машинный перевод сохраняется с пометкой и клиенту не виден до принятия; сбой модели не мешает перевести вручную', async () => {
  const { number } = await createProblem(l2, { internalTitle: 'Накладные' });
  await saveProblemTranslation(l2, { number, locale: 'ru', publicTitle: 'Не проводятся накладные', publicBody: 'Исправляем ошибку.' });
  await setProblemShown(l2, { number, shown: true });
  await requestProblemTranslation(l2, { number, locale: 'en' });
  const job = jobs.sent.find((j) => j.name === 'problems.translate');
  expect(job?.data).toMatchObject({ locale: 'en' });
  await runProblemTranslationJob(system, job!.data);
  // В модель ушёл только текст сотрудника; журнал вызова с целью problem_translation.
  expect(stub.calls).toHaveLength(1);
  expect(stub.calls[0]!.data).toContain('Не проводятся накладные');
  expect(stub.calls[0]!.data).not.toContain('Накладные</');
  expect((await pools.root.query(`select purpose, outcome from hda_runs`)).rows).toEqual([{ purpose: 'problem_translation', outcome: 'ok' }]);
  expect((await texts(number)).find((t) => t.locale === 'en')).toMatchObject({ is_machine: true, accepted_by: null });
  expect((await clientSees()).map((r) => r.locale)).toEqual(['ru']);
  await saveProblemTranslation(l2, { number, locale: 'en', publicTitle: 'Не проводятся накладные', publicBody: 'Исправляем ошибку.', acceptMachine: true });
  expect((await texts(number)).find((t) => t.locale === 'en')).toMatchObject({ is_machine: true, accepted_by: l2.user.id });
  expect((await clientSees()).map((r) => r.locale).sort()).toEqual(['en', 'ru']);

  // Модель сломана: перевод не появляется, сотрудник пишет его сам.
  stub.broken = 'not_json';
  await requestProblemTranslation(l2, { number, locale: 'uz' });
  await expect(runProblemTranslationJob(system, jobs.sent.at(-1)!.data)).rejects.toThrow();
  expect((await texts(number)).find((t) => t.locale === 'uz')).toBeUndefined();
  await saveProblemTranslation(l2, { number, locale: 'uz', publicTitle: 'Nakladnoylar o‘tmayapti', publicBody: 'Tuzatyapmiz.' });
  expect((await texts(number)).find((t) => t.locale === 'uz')).toMatchObject({ is_machine: false });
});

test('сигнатуры: добавить из привязанных обращений, занятая другой активной отклоняется, убрать', async () => {
  const { number } = await createProblem(l2, { internalTitle: 'Первая' });
  const other = await createProblem(l2, { internalTitle: 'Вторая' });
  await addProblemSignature(l2, { number, signature: SIG });
  await expect(addProblemSignature(l2, { number: other.number, signature: SIG })).rejects.toMatchObject({ code: 'signature_taken' });
  await expect(addProblemSignature(l2, { number, signature: 'not-a-signature' })).rejects.toMatchObject({ code: 'invalid_input' });
  await expect(addProblemSignature(staffCtx(f.l1), { number, signature: SIG })).rejects.toMatchObject({ code: 'forbidden' });
  expect((await problemCard(l2, number))?.signatures).toEqual([{ signature: SIG, ticketCount: 0, isActive: true }]);
  await removeProblemSignature(l2, { number, signature: SIG });
  expect((await problemCard(l2, number))?.signatures).toEqual([]);
  expect((await audit('problem.signature_')).map((a) => a.action)).toEqual(['problem.signature_added', 'problem.signature_removed']);
});

test('карточка: обращения, организации, категории, первое и последнее появление; список с поиском по номеру и названию', async () => {
  await pools.root.query(`update hdu_organizations set category = 'A' where org_id = $1`, [f.orgA.orgId]);
  await pools.root.query(`update hdu_organizations set category = 'C' where org_id = $1`, [f.orgB.orgId]);
  const { number } = await createProblemFromTicket(l2, { ticketNumber: f.tickets.aOrg.number });
  await pools.root.query(`update hdt_tickets set known_problem_id = (select problem_id from hdp_problems where number = $1) where ticket_id = any($2)`, [number, [f.tickets.aMine.ticketId, f.tickets.bOrg.ticketId]]);
  await saveProblem(l2, { number, internalTitle: 'Накладные не проводятся', moduleId: null, workaroundNumber: null });
  const card = await problemCard(l2, number);
  expect(card).toMatchObject({ number, internalTitle: 'Накладные не проводятся', ticketCount: 3, orgCount: 2, categories: { A: 1, C: 1 } });
  expect(card?.tickets.map((t) => t.number).sort()).toEqual([f.tickets.aOrg.number, f.tickets.aMine.number, f.tickets.bOrg.number].sort());
  expect(card?.tickets.find((t) => t.number === f.tickets.bOrg.number)).toMatchObject({ orgName: 'Globex' });
  expect((await listProblems(l2, { q: 'наклад' })).map((p) => p.number)).toEqual([number]);
  expect((await listProblems(l2, { q: `KP-${number}` })).map((p) => p.number)).toEqual([number]);
  expect(await listProblems(l2, { q: 'отчёт' })).toEqual([]);
  expect(await problemCard(l2, 999_999)).toBeNull();
});

// Решение 20 плана M8b: черновик не привязывает обращения и не делает сигнатуру действующей (hdp-agent-draft.test.ts).
test('черновик проблемы для AI-сотрудника: только сигнатура и предложенные обращения, без признака показа и публичного текста', async () => {
  const { number } = await createProblemDraft(system, { internalTitle: 'Всплеск сигнатуры', signature: SIG, ticketIds: [f.tickets.aOrg.ticketId, f.tickets.bOrg.ticketId] });
  const row = await problemRow(number);
  expect(row).toMatchObject({ show_to_clients: false, status: 'draft', ticket_count: 0 });
  expect(await texts(number)).toEqual([]);
});
