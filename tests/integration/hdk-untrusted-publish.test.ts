import { afterEach, beforeEach, expect, test } from 'vitest';
import type { SystemActor } from '@/db/with-actor';
import { runCandidateJob } from '@/modules/hda/api/candidates';
import { candidateToDraft } from '@/modules/hda/api/candidate-actions';
import { setAiClientForTests, StubAiClient } from '@/modules/hda/testing';
import { MemoryJobQueue, setJobQueueForTests } from '@/modules/hdc/testing';
import { saveSolutionDraft, saveSolutionMeta, solutionEditorState } from '@/modules/hdk/api/editor';
import { confirmUntrustedFindings } from '@/modules/hdk/api/from-candidate';
import { publishSolution } from '@/modules/hdk/api/publish';
import { setEmbedderForTests } from '@/modules/hdk/embeddings';
import { createStubEmbedder } from '@/modules/hdk/embeddings/stub';
import { createTicket } from '@/modules/hdt/api';
import { clientCtx, staffCtx, staffWithRole } from './helpers/auth';
import { pools } from './helpers/db';
import { type Fixture, seedTwoOrgs } from './isolation/fixture';

// Отдельное подтверждение недоверенного текста (ТЗ FR-CAND-09, угроза T33; план M5c, задача 10, решение 30): решение из
// кандидата не публикуется, пока каждая находка "телефон", "почта", "команда", "код" не отмечена; правка текста
// отметки сбрасывает. Обычное решение (не из кандидата) этой проверки не получает.

const SYSTEM: SystemActor = { type: 'system', job: 'ai.candidate' };
let f: Fixture;
let l2: ReturnType<typeof staffCtx>;
let serial = 0;
const newId = () => `ut${String(++serial).padStart(10, '0')}`;

beforeEach(async () => {
  f = await seedTwoOrgs();
  l2 = staffCtx(await staffWithRole('agent_l2'));
  setAiClientForTests(
    new StubAiClient(
      () => ({ title: 'Сброс кеша обмена', problem: 'Обмен с кассой стоит. Пишите на help@example.uz', steps: ['Введите `reset_cache()` в консоли', 'Выполните DROP TABLE exchange_queue;'], confident: true }),
    ),
  );
  setJobQueueForTests(new MemoryJobQueue());
  setEmbedderForTests(createStubEmbedder());
  await pools.root.query(`delete from hda_runs`);
  await pools.root.query(`delete from hdc_settings where code like 'candidates.%'`);
});
afterEach(() => {
  setAiClientForTests();
  setJobQueueForTests(null);
  setEmbedderForTests(null);
});

async function draftFromCandidate(): Promise<number> {
  const { ticketId } = await createTicket(await clientCtx(f.aUser), { description: 'Обмен с кассой стоит', type: 'bug', impact: 'minor', locale: 'ru' });
  await pools.root.query(`update hdt_tickets set status = 'resolved', resolution_type = 'solved', resolved_on = now() where ticket_id = $1`, [ticketId]);
  await runCandidateJob(SYSTEM, { ticketId });
  const id = (await pools.root.query(`select candidate_id from hda_candidate_sources where ticket_id = $1`, [ticketId])).rows[0].candidate_id as string;
  const { articleNumber } = await candidateToDraft(l2, { id }, { what: 'Что видит', why: 'Почему', do: 'Что сделать' }, newId);
  const moduleId = (await pools.root.query(`insert into hdr_product_modules (code, name) values ('ut-${Date.now()}', '{"ru": "Касса"}') returning module_id`)).rows[0].module_id as string;
  await saveSolutionMeta(l2, { number: articleNumber, moduleId, audience: 'internal' });
  return articleNumber;
}

test('каждая находка отмечается; без отметок публикации нет; правка текста сбрасывает отметки', async () => {
  const number = await draftFromCandidate();
  let state = await solutionEditorState(l2, { number });
  const findings = state!.review.untrusted!.findings;
  expect(findings.map((x) => x.kind).sort()).toEqual(['code', 'command', 'email']);
  const ref = () => ({ number, locale: 'ru' as const, versionId: state!.current.versionId, revision: state!.current.revision, confirmFindings: true });
  // Отмечены не все: публикации нет.
  expect((await publishSolution(l2, { ...ref(), untrustedConfirmed: findings.slice(0, 2).map((x) => x.fingerprint) })).status).toBe('not_ready');
  // Отметки в версии отдельным действием.
  expect(await confirmUntrustedFindings(l2, { number, locale: 'ru', versionId: state!.current.versionId, fingerprints: findings.map((x) => x.fingerprint) })).toEqual({ confirmed: 3 });
  state = await solutionEditorState(l2, { number });
  expect(state!.review.untrusted!.confirmed.sort()).toEqual(findings.map((x) => x.fingerprint).sort());
  // Правка текста: отметки больше не действуют.
  const doc = state!.current.doc as { version: 1; blocks: unknown[] };
  const saved = await saveSolutionDraft(l2, { number, locale: 'ru', versionId: state!.current.versionId, revision: state!.current.revision, title: 'Сброс кеша обмена с кассой', doc });
  expect(saved.status).toBe('saved');
  state = await solutionEditorState(l2, { number });
  expect(state!.review.untrusted!.confirmed).toEqual([]);
  expect((await publishSolution(l2, ref())).status).toBe('not_ready');
  expect((await publishSolution(l2, { ...ref(), untrustedConfirmed: state!.review.untrusted!.findings.map((x) => x.fingerprint) })).status).toBe('published');
  expect((await pools.root.query(`select count(*)::int as n from hdc_audit_log where action = 'solution.untrusted_confirmed'`)).rows[0].n).toBe(2);
});
