import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SystemActor } from '@/db/with-actor';
import { createDraftArticle } from '@/modules/hdk/api/articles';
import { solutionEditorState } from '@/modules/hdk/api/editor';
import { publishSolution } from '@/modules/hdk/api/publish';
import { runIndexJob } from '@/modules/hdk/api/search-jobs';
import { searchSolutions } from '@/modules/hdk/api/suggest';
import { getEmbedder } from '@/modules/hdk/embeddings';
import { signatureFromText } from '@/modules/hdk/signature';
import { clientCtx, staffCtx, staffWithRole } from '../integration/helpers/auth';
import { pools } from '../integration/helpers/db';
import { seedTwoOrgs } from '../integration/isolation/fixture';
import { liveSearch } from '../integration/helpers/search';
import { runSearchSync, setSearchForTests, setSearchKeysForTests } from '@/modules/hdc/api';
import { registerSearch } from '@/worker/search';
import { type EvalCase, type EvalReport, formatReport, parseEvalSet, scoreEval } from './score';

// Прогон проверочного набора поиска (ТЗ 15.4; план M5, задача 11) по настоящей базе: решения набора публикуются
// обычным путём (черновик, публикация, задача индекса), каждый запрос идёт через ту же функцию поиска, что подсказка
// клиента (searchSolutions от имени клиента, аудитория clients, сигнатура из текста запроса). База: контейнер
// testcontainers из настройки интеграционных тестов, поэтому прогон начинается с пустой базы. Векторы: тот же выбор,
// что у портала (EMBEDDINGS, по умолчанию заглушка).

export const EVAL_DIR = 'tests/eval/search';
const SYSTEM: SystemActor = { type: 'system', job: 'kb.index' };

/**
 * typesense: слова подсказки из настоящего Typesense (план W6, задача 6): индекс строится тем же search.sync, что у
 * фонового процесса. Без контейнера (TYPESENSE_TEST_URL) прогон с этим ключом невозможен и бросает.
 */
export async function runSearchEval(dir: string = EVAL_DIR, opts: { typesense?: boolean } = {}): Promise<{ report: EvalReport; lines: string[]; cases: EvalCase[] }> {
  const set = parseEvalSet(readFileSync(join(dir, 'solutions.json'), 'utf8'), readFileSync(join(dir, 'queries.json'), 'utf8'));
  const f = await seedTwoOrgs();
  await pools.root.query(`delete from hdk_search_documents`);
  // Панель готовности публикации требует модуль (UX-W-07).
  const moduleId = (await pools.root.query(`insert into hdr_product_modules (code, name) values ($1, '{"ru": "Проверочный набор"}') returning module_id`, [`eval-${Date.now()}`])).rows[0].module_id as string;
  const writer = staffCtx(await staffWithRole('agent_l1'));
  const publisher = staffCtx(await staffWithRole('agent_l2'));
  let serial = 0;
  const id = () => `ev${String(++serial).padStart(10, '0')}`;
  const paragraph = (text: string) => ({ type: 'paragraph' as const, attrs: { id: id() }, content: [{ type: 'text' as const, text }] });
  const refOf = new Map<string, string>();
  for (const s of set.solutions) {
    const doc = { version: 1 as const, blocks: [paragraph(s.what), ...s.steps.map((text) => ({ type: 'step' as const, attrs: { id: id() }, content: [paragraph(text)] }))] };
    const created = await createDraftArticle(writer, { locale: s.locale, title: s.title, audience: 'clients', moduleId, doc });
    const state = await solutionEditorState(writer, { number: created.number });
    if (!state) throw new Error(`Решение ${s.ref} не создано`);
    const outcome = await publishSolution(publisher, { number: created.number, locale: s.locale, versionId: state.current.versionId, revision: state.current.revision, confirmFindings: true });
    if (outcome.status !== 'published') throw new Error(`Решение ${s.ref} не опубликовано: ${outcome.status}`);
    await runIndexJob(SYSTEM, { articleId: created.articleId });
    refOf.set(created.articleId, s.ref);
  }
  if (opts.typesense) {
    registerSearch();
    const live = await liveSearch();
    setSearchForTests(live.reader, live.writer);
    setSearchKeysForTests({ client: live.keys.clientSearch, staff: live.keys.staffSearch });
    await runSearchSync(SYSTEM, live.writer);
  }
  const client = (await clientCtx(f.aUser)).actor;
  const cases: EvalCase[] = [];
  for (const query of set.queries) {
    const { items } = await searchSolutions(client, { text: query.query, signature: signatureFromText(query.query), moduleId: null, locale: query.locale, audiences: ['clients'] });
    cases.push({ query, shown: items.map((item) => refOf.get(item.articleId) ?? `#${item.number}`) });
  }
  if (opts.typesense) {
    setSearchForTests(null);
    setSearchKeysForTests(null);
  }
  const report = scoreEval(cases);
  return { report, cases, lines: formatReport(report, { embedder: `${getEmbedder().name}${opts.typesense ? ', слова из Typesense' : ''}`, solutions: set.solutions.length, queries: set.queries.length }) };
}
