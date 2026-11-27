import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, expect, test } from 'vitest';
import type { SystemActor } from '@/db/with-actor';
import { runCandidateJob } from '@/modules/hda/api/candidates';
import { candidateCard, candidateToDraft, listCandidates, mergeCandidate, rejectCandidate } from '@/modules/hda/api/candidate-actions';
import { setAiClientForTests, StubAiClient } from '@/modules/hda/testing';
import { MemoryJobQueue, setJobQueueForTests } from '@/modules/hdc/testing';
import { saveSolutionMeta, solutionEditorState } from '@/modules/hdk/api/editor';
import { publishSolution } from '@/modules/hdk/api/publish';
import { runIndexJob } from '@/modules/hdk/api/search-jobs';
import { searchSolutions, suggestForClient, suggestForWidget } from '@/modules/hdk/api/suggest';
import { setEmbedderForTests } from '@/modules/hdk/embeddings';
import { createStubEmbedder } from '@/modules/hdk/embeddings/stub';
import { createTicket } from '@/modules/hdt/api';
import { clientCtx, staffCtx, staffWithRole } from './helpers/auth';
import { pools } from './helpers/db';
import { type Fixture, seedTwoOrgs } from './isolation/fixture';

// Очередь кандидатов и решение из кандидата (ТЗ FR-CAND-04, 06, 09, FR-SOL-04, 05; строка M5c 16.2 "кандидат не
// находится подсказкой до публикации"; план M5c, задача 10, решения 29, 30).

const SYSTEM: SystemActor = { type: 'system', job: 'ai.candidate' };
const INDEX: SystemActor = { type: 'system', job: 'kb.index' };
const LABELS = { what: 'Что видит пользователь', why: 'Почему так происходит', do: 'Что сделать' };
let serial = 0;
const newId = () => `ca${String(++serial).padStart(10, '0')}`;
const WORDS = 'Квартальный реестр шлюза не выгружается';
let f: Fixture;
let l2: ReturnType<typeof staffCtx>;

beforeEach(async () => {
  f = await seedTwoOrgs();
  l2 = staffCtx(await staffWithRole('agent_l2'));
  setAiClientForTests(new StubAiClient(() => ({ title: WORDS, problem: `${WORDS} при выгрузке в банк.`, steps: ['Откройте настройки шлюза.', 'Позвоните +998 90 111 22 33', 'Выполните sudo systemctl restart gateway'], confident: true })));
  setJobQueueForTests(new MemoryJobQueue());
  setEmbedderForTests(createStubEmbedder());
  await pools.root.query(`delete from hda_runs`);
  await pools.root.query(`delete from hdc_rate_limits`);
  await pools.root.query(`delete from hdk_search_documents`);
  await pools.root.query(`delete from hdc_settings where code like 'candidates.%' or code = 'kb.allowed_domains'`);
});
afterEach(() => {
  setAiClientForTests();
  setJobQueueForTests(null);
  setEmbedderForTests(null);
});

async function candidate(user = f.aUser): Promise<string> {
  const { ticketId } = await createTicket(await clientCtx(user), { description: 'Не выгружается реестр', type: 'bug', impact: 'minor', locale: 'ru' });
  await pools.root.query(`update hdt_tickets set status = 'resolved', resolution_type = 'solved', resolved_on = now() where ticket_id = $1`, [ticketId]);
  await runCandidateJob(SYSTEM, { ticketId });
  return (await pools.root.query(`select candidate_id from hda_candidate_sources where ticket_id = $1`, [ticketId])).rows[0].candidate_id as string;
}

/** Ищется ли текст кандидата подсказкой клиента, виджета, поиском помощника и поиском сотрудника. */
async function found(): Promise<boolean[]> {
  const client = await clientCtx(f.aUser);
  const forClient = await suggestForClient(client, { text: WORDS, sessionId: randomUUID(), locale: 'ru' });
  const forWidget = await suggestForWidget(client, { text: WORDS, sessionId: randomUUID(), locale: 'ru' });
  const assistant = await searchSolutions(client.actor, { text: WORDS, signature: null, moduleId: null, locale: 'ru', audiences: ['clients'] });
  const staff = await searchSolutions(l2.actor, { text: WORDS, signature: null, moduleId: null, locale: 'ru', audiences: ['clients', 'internal'] });
  return [forClient.items.length > 0, forWidget.items.length > 0, assistant.items.length > 0, staff.items.length > 0];
}

test('строка M5c 16.2: кандидат не находится подсказкой до публикации, после "Сделать черновиком" тоже, после публикации находится', async () => {
  const id = await candidate();
  expect(await found()).toEqual([false, false, false, false]);
  const card = await candidateCard(l2, { id });
  expect(card).toMatchObject({ title: WORDS, sourceCount: 1 });
  // Источники видны сотруднику на экране проверки.
  expect(card!.sourceTickets).toHaveLength(1);
  const { articleNumber } = await candidateToDraft(l2, { id }, LABELS, newId);
  expect((await pools.root.query(`select status, article_id from hda_solution_candidates where candidate_id = $1`, [id])).rows[0].status).toBe('accepted');
  const article = (await pools.root.query(`select article_id, audience, is_untrusted from hdk_articles where number = $1`, [articleNumber])).rows[0];
  expect(article).toMatchObject({ audience: 'internal', is_untrusted: true });
  expect((await pools.root.query(`select count(*)::int as n from hdk_article_sources where article_id = $1`, [article.article_id])).rows[0].n).toBe(1);
  expect(await found()).toEqual([false, false, false, false]);

  // Публикация обычным порядком: аудитория клиентам, отметка каждой находки, проверка FR-SOL-04.
  const moduleId = (await pools.root.query(`insert into hdr_product_modules (code, name) values ('ca-${Date.now()}', '{"ru": "Банк"}') returning module_id`)).rows[0].module_id as string;
  await saveSolutionMeta(l2, { number: articleNumber, moduleId, audience: 'clients' });
  const state = await solutionEditorState(l2, { number: articleNumber });
  const blocked = await publishSolution(l2, { number: articleNumber, locale: 'ru', versionId: state!.current.versionId, revision: state!.current.revision, confirmFindings: true });
  expect(blocked.status).toBe('not_ready');
  const untrusted = blocked.status === 'not_ready' ? blocked.untrusted! : null;
  expect(untrusted!.findings.map((x) => x.kind).sort()).toEqual(['command', 'phone']);
  const done = await publishSolution(l2, { number: articleNumber, locale: 'ru', versionId: state!.current.versionId, revision: state!.current.revision, confirmFindings: true, untrustedConfirmed: untrusted!.findings.map((x) => x.fingerprint) });
  expect(done.status).toBe('published');
  await runIndexJob(INDEX, { articleId: article.article_id });
  expect(await found()).toEqual([true, true, true, true]);
});

test('объединить с решением: источники к решению, "пригодилось сотрудникам" растёт; отклонить только с причиной; журнал на каждое', async () => {
  const first = await candidate();
  const { articleNumber } = await candidateToDraft(l2, { id: first }, LABELS, newId);
  // Второй похожий кандидат появился после решения: склеивать с принятым нельзя, он отдельный.
  const second = await candidate(f.bUser);
  expect(second).not.toBe(first);
  await mergeCandidate(l2, { id: second, articleNumber });
  const article = (await pools.root.query(`select article_id, staff_useful_count from hdk_articles where number = $1`, [articleNumber])).rows[0];
  expect(article.staff_useful_count).toBe(1);
  expect((await pools.root.query(`select count(*)::int as n from hdk_article_sources where article_id = $1`, [article.article_id])).rows[0].n).toBe(2);
  expect((await pools.root.query(`select status from hda_solution_candidates where candidate_id = $1`, [second])).rows[0].status).toBe('merged');

  const third = await candidate();
  await expect(rejectCandidate(l2, { id: third })).rejects.toMatchObject({ code: 'invalid_input' });
  await rejectCandidate(l2, { id: third, reason: 'too_specific', comment: 'Только у одного клиента' });
  expect((await pools.root.query(`select status, reject_reason, rejected_at_source_count from hda_solution_candidates where candidate_id = $1`, [third])).rows[0]).toEqual({ status: 'rejected', reject_reason: 'too_specific', rejected_at_source_count: 1 });
  expect((await listCandidates(l2, { status: 'rejected' })).map((c) => c.candidateId)).toEqual([third]);

  const actions = (await pools.root.query(`select action from hdc_audit_log where action like 'candidate.%' order by created_on`)).rows.map((r) => r.action);
  expect(actions).toEqual(['candidate.accepted', 'candidate.merged', 'candidate.rejected']);
});

test('product ничего не делает с кандидатами; первая линия может', async () => {
  const id = await candidate();
  const product = staffCtx(await staffWithRole('product'));
  await expect(listCandidates(product, {})).rejects.toMatchObject({ code: 'forbidden' });
  await expect(candidateCard(product, { id })).rejects.toMatchObject({ code: 'forbidden' });
  await expect(candidateToDraft(product, { id }, LABELS, newId)).rejects.toMatchObject({ code: 'forbidden' });
  await expect(rejectCandidate(product, { id, reason: 'other' })).rejects.toMatchObject({ code: 'forbidden' });
  expect((await listCandidates(staffCtx(f.l1), {})).map((c) => c.candidateId)).toEqual([id]);
});
