import { afterEach, beforeEach, expect, test } from 'vitest';
import type { SystemActor } from '@/db/with-actor';
import { candidateConfig, runCandidateJob, runCandidatesEmbed, runCandidatesSweep } from '@/modules/hda/api/candidates';
import { saveCandidateSettings } from '@/modules/hda/api/settings';
import { setAiClientForTests, StubAiClient } from '@/modules/hda/testing';
import { MemoryJobQueue, setJobQueueForTests } from '@/modules/hdc/testing';
import { type EmbeddingProvider, EmbeddingUnavailableError, setEmbedderForTests } from '@/modules/hdk/embeddings';
import { createStubEmbedder, stubVector } from '@/modules/hdk/embeddings/stub';
import { createTicket } from '@/modules/hdt/api';
import { clientCtx, staffCtx } from './helpers/auth';
import { asActor, pools } from './helpers/db';
import { type Fixture, seedTwoOrgs } from './isolation/fixture';

// Кандидаты в решения: черновик и склейка (ТЗ 7.16, FR-CAND-01, 02, 03, 05, 07, 09, 14.3, 15.2; план M5c, задача 9,
// решения 26-28). Обход находит закрытые обращения без решения, задание готовит черновик тем же путём, что черновик
// решения, и склеивает похожие по векторам. Заглушка модели записывает тело каждого запроса.

const SYSTEM: SystemActor = { type: 'system', job: 'ai.candidate' };
let f: Fixture;
let stub: StubAiClient;
let jobs: MemoryJobQueue;
const DRAFT = { title: 'Документ не проводится из-за закрытого периода', problem: 'При проведении документа появляется сообщение о закрытом периоде.', steps: ['Откройте настройки периода.', 'Откройте период и проведите документ снова.'], confident: true };

beforeEach(async () => {
  f = await seedTwoOrgs();
  stub = new StubAiClient();
  setAiClientForTests(stub);
  jobs = new MemoryJobQueue();
  setJobQueueForTests(jobs);
  setEmbedderForTests(createStubEmbedder());
  await pools.root.query(`delete from hda_runs`);
  await pools.root.query(`delete from hdc_rate_limits`);
  await pools.root.query(`delete from hdk_search_documents`);
  await pools.root.query(`delete from hdc_settings where code like 'candidates.%' or code = 'kb.allowed_domains'`);
  await pools.root.query(`insert into hdc_settings (code, value) values ('kb.allowed_domains', '["smartup.uz"]'::jsonb)`);
});
afterEach(() => {
  setAiClientForTests();
  setJobQueueForTests(null);
  setEmbedderForTests(null);
});

/** Обращение клиента, решённое с итогом; resolvedDaysAgo: сколько суток назад. */
async function closed(user: Fixture['aUser'], opts: { resolution?: string; daysAgo?: number; text?: string } = {}): Promise<string> {
  const { ticketId } = await createTicket(await clientCtx(user), { description: opts.text ?? 'Не проводится документ: закрытый период', type: 'bug', impact: 'minor', locale: 'ru' });
  await pools.root.query(`update hdt_tickets set status = 'resolved', resolution_type = $2, resolved_on = now() - make_interval(days => $3) where ticket_id = $1`, [ticketId, opts.resolution ?? 'solved', opts.daysAgo ?? 0]);
  await pools.root.query(`insert into hdt_ticket_messages (org_id, ticket_id, author_id, author_type, body, is_internal) values ($1, $2, $3, 'staff', 'Откройте период в настройках', false), ($1, $2, $3, 'staff', 'ЗАМЕТКА-СЕКРЕТ', true)`, [
    user.actor.orgId,
    ticketId,
    f.l1.userId,
  ]);
  return ticketId;
}
const queued = () => jobs.sent.filter((j) => j.name === 'ai.candidate').map((j) => j.data.ticketId);
const candidates = () => pools.root.query(`select * from hda_solution_candidates order by created_on`).then((r) => r.rows);

test('обход: решённое без решения даёт задание; другие итоги, с решением, с источником, без AI и старше 7 суток нет', async () => {
  const good = await closed(f.aUser);
  const notRepro = await closed(f.aUser, { resolution: 'not_reproducible' });
  const dup = await closed(f.aUser, { resolution: 'duplicate' });
  const old = await closed(f.aUser, { daysAgo: 8 });
  const withSolution = await closed(f.aUser);
  const article = (await pools.root.query(`insert into hdk_articles (audience, original_locale) values ('clients', 'ru') returning article_id`)).rows[0].article_id;
  await pools.root.query(`update hdt_tickets set solution_id = $2 where ticket_id = $1`, [withSolution, article]);
  const withSource = await closed(f.aUser);
  await pools.root.query(`insert into hdk_article_sources (org_id, article_id, ticket_id) values ($1, $2, $3)`, [f.orgA.orgId, article, withSource]);
  const noAi = await closed(f.bUser);
  await pools.root.query(`update hdu_organizations set is_ai_enabled = false where org_id = $1`, [f.orgB.orgId]);
  expect(await runCandidatesSweep(SYSTEM)).toEqual({ queued: 1 });
  expect(queued()).toEqual([good]);
  void [notRepro, dup, old, noAi];
  // Выключатель кандидатов: обход ничего не ставит.
  await pools.root.query(`insert into hdc_settings (code, value) values ('candidates.enabled', 'false'::jsonb)`);
  expect(await runCandidatesSweep(SYSTEM)).toEqual({ queued: 0 });
});

test('черновик кандидата: вход только по перечню 14.3, текст у сотрудников, повтор не вызывает модель', async () => {
  const ticketId = await closed(f.aUser, { text: `Не проводится документ. Пишет ${f.orgA.name}, тел. +998 90 123 45 67` });
  expect(await runCandidateJob(SYSTEM, { ticketId })).toBe('created');
  expect(stub.calls).toHaveLength(1);
  const body = JSON.stringify(stub.calls[0]);
  for (const forbidden of ['ЗАМЕТКА-СЕКРЕТ', f.orgA.name, '123 45 67']) expect(body, forbidden).not.toContain(forbidden);
  expect(stub.calls[0]!.model).toBe('claude-haiku-5-5');
  const [c] = await candidates();
  expect(c).toMatchObject({ title: DRAFT.title, problem: DRAFT.problem, steps: DRAFT.steps, status: 'new', source_count: 1, org_count: 1, locale: 'ru' });
  expect(c.embedding).not.toBeNull();
  expect((await pools.root.query(`select ticket_id from hda_candidate_sources where candidate_id = $1`, [c.candidate_id])).rows).toEqual([{ ticket_id: ticketId }]);
  // Повтор задания и обхода: модель второй раз не вызывается, второго источника нет.
  expect(await runCandidateJob(SYSTEM, { ticketId })).toBe('refused');
  expect(await runCandidatesSweep(SYSTEM)).toEqual({ queued: 0 });
  expect(stub.calls).toHaveLength(1);
  // Клиент не читает ни кандидатов, ни источников ("Не найдено", 15.2).
  for (const actor of [f.aUser.actor, f.aAdmin.actor])
    for (const table of ['hda_solution_candidates', 'hda_candidate_sources']) expect((await asActor(pools.app, actor, (c2) => c2.query(`select 1 from ${table}`))).rows, table).toEqual([]);
});

test('модель не уверена: кандидата нет, в журнале решение skipped', async () => {
  stub.respond = () => ({ ...DRAFT, confident: false });
  const ticketId = await closed(f.aUser);
  expect(await runCandidateJob(SYSTEM, { ticketId })).toBe('skipped');
  expect(await candidates()).toEqual([]);
  expect((await pools.root.query(`select purpose, decision, ticket_id from hda_runs`)).rows).toEqual([{ purpose: 'candidate', decision: 'skipped', ticket_id: ticketId }]);
});

test('ссылка вне разрешённых доменов вырезана до записи; телефон остаётся и подсвечен находкой', async () => {
  stub.respond = () => ({ ...DRAFT, problem: 'Подробнее на https://evil.example/x и https://smartup.uz/help', steps: ['Позвоните +998 90 111 22 33', 'Откройте www.evil.example/путь'] });
  expect(await runCandidateJob(SYSTEM, { ticketId: await closed(f.aUser) })).toBe('created');
  const [c] = await candidates();
  expect(JSON.stringify(c)).not.toContain('evil.example');
  expect(c.problem).toContain('https://smartup.uz/help');
  expect(c.steps[0]).toContain('+998 90 111 22 33');
  expect(c.findings).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'phone' })]));
});

test('похоже на опубликованное решение: кандидата нет, решению "пригодилось сотрудникам" (FR-CAND-03)', async () => {
  // Опубликованное внутреннее решение того же содержания в поисковом индексе: сходство по любой аудитории.
  const a = (await pools.root.query(`insert into hdk_articles (audience, original_locale) values ('internal', 'ru') returning article_id, number`)).rows[0];
  const article = a.article_id as string;
  const doc = { version: 1, blocks: [] };
  const v = (await pools.root.query(`insert into hdk_article_versions (article_id, locale, number, title, doc, state) values ($1, 'ru', 1, 'x', $2, 'published') returning version_id`, [article, doc])).rows[0].version_id;
  const published = (
    await pools.root.query(`insert into hdk_published (article_id, article_number, locale, version_id, audience, title, doc, body_text, slug, original_locale) values ($1, $2, 'ru', $3, 'internal', 'x', $4, 'x', 'x', 'ru') returning published_id`, [article, a.number, v, doc])
  ).rows[0].published_id;
  await pools.root.query(`insert into hdk_search_documents (published_id, ref_id, kind, article_type, locale, title, body_text, embedding, audience) values ($1, $2, 'article', 'solution', 'ru', 'x', 'x', $3::vector, 'internal')`, [
    published,
    article,
    JSON.stringify(stubVector(`${DRAFT.title}\n${DRAFT.problem}`)),
  ]);
  expect(await runCandidateJob(SYSTEM, { ticketId: await closed(f.aUser) })).toBe('useful');
  expect(await candidates()).toEqual([]);
  expect((await pools.root.query(`select staff_useful_count from hdk_articles where article_id = $1`, [article])).rows[0].staff_useful_count).toBe(1);
});

test('второй похожий черновик склеивается: источники и организации пересчитаны; отклонённый возвращается на пятом источнике', async () => {
  expect(await runCandidateJob(SYSTEM, { ticketId: await closed(f.aUser) })).toBe('created');
  expect(await runCandidateJob(SYSTEM, { ticketId: await closed(f.bUser) })).toBe('merged');
  expect(await runCandidateJob(SYSTEM, { ticketId: await closed(f.aUser) })).toBe('merged');
  const [c] = await candidates();
  expect(c).toMatchObject({ source_count: 3, org_count: 2 });
  // Отклонён при трёх источниках: вернётся в очередь на восьмом (пять новых).
  await pools.root.query(`update hda_solution_candidates set status = 'rejected', reject_reason = 'too_specific', rejected_at_source_count = 3, decided_on = now() where candidate_id = $1`, [c.candidate_id]);
  for (let i = 0; i < 4; i++) await runCandidateJob(SYSTEM, { ticketId: await closed(f.aUser) });
  expect((await candidates())[0]).toMatchObject({ status: 'rejected', source_count: 7 });
  await runCandidateJob(SYSTEM, { ticketId: await closed(f.aUser) });
  expect((await candidates())[0]).toMatchObject({ status: 'new', source_count: 8 });
  expect((await pools.root.query(`select diff from hdc_audit_log where object_id = $1 and action = 'candidate.returned'`, [c.candidate_id])).rows).toEqual([{ diff: { sourceCount: 8, rejectedAtSourceCount: 3 } }]);
});

test('без векторов кандидат создаётся после трёх попыток, ночная задача досчитывает векторы и склеивает', async () => {
  let attempts = 0;
  const broken: EmbeddingProvider = {
    name: 'stub',
    dimensions: 1024,
    async embed() {
      attempts++;
      throw new EmbeddingUnavailableError('unreachable');
    },
  };
  setEmbedderForTests(broken);
  expect(await runCandidateJob(SYSTEM, { ticketId: await closed(f.aUser) })).toBe('created');
  expect(attempts).toBe(3);
  expect(await runCandidateJob(SYSTEM, { ticketId: await closed(f.bUser) })).toBe('created');
  expect((await candidates()).map((c) => c.embedding)).toEqual([null, null]);
  setEmbedderForTests(createStubEmbedder());
  expect(await runCandidatesEmbed(SYSTEM)).toEqual({ embedded: 2, merged: 1 });
  const rows = await candidates();
  expect(rows.filter((c) => c.status === 'new')).toHaveLength(1);
  expect(rows.find((c) => c.status === 'new')).toMatchObject({ source_count: 2, org_count: 2 });
});

test('дневной предел кандидатов соблюдён', async () => {
  await pools.root.query(`insert into hdc_settings (code, value) values ('candidates.daily_limit', '1'::jsonb)`);
  expect(await runCandidateJob(SYSTEM, { ticketId: await closed(f.aUser) })).toBe('created');
  expect(await runCandidateJob(SYSTEM, { ticketId: await closed(f.aUser) })).toBe('refused');
  expect(stub.calls).toHaveLength(1);
});

test('настройки кандидатов: только администратор со свежим входом, журнал аудита на каждое значение', async () => {
  const admin = staffCtx(f.adminStaff);
  await saveCandidateSettings(admin, { dailyLimit: '10', publishedPercent: '90', mergePercent: '80' });
  expect(await candidateConfig()).toEqual({ enabled: false, dailyLimit: 10, publishedSimilarity: 0.9, mergeSimilarity: 0.8 });
  expect((await pools.root.query(`select object_id from hdc_audit_log where action = 'settings.changed' and object_id like 'candidates.%' order by object_id`)).rows.map((r) => r.object_id)).toEqual([
    'candidates.daily_limit',
    'candidates.enabled',
    'candidates.merge_similarity',
    'candidates.published_similarity',
  ]);
  await expect(saveCandidateSettings(staffCtx(f.care), { enabled: 'on', dailyLimit: '5', publishedPercent: '90', mergePercent: '80' })).rejects.toMatchObject({ code: 'forbidden' });
  await expect(saveCandidateSettings({ ...admin, freshAuthAt: new Date(Date.now() - 3600_000) }, { dailyLimit: '5', publishedPercent: '90', mergePercent: '80' })).rejects.toMatchObject({ code: 'stale_session' });
  await expect(saveCandidateSettings(admin, { dailyLimit: '-1', publishedPercent: '90', mergePercent: '80' })).rejects.toMatchObject({ code: 'invalid_input' });
});
