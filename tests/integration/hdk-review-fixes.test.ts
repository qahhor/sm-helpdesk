import { afterEach, beforeEach, expect, test } from 'vitest';
import { withActor } from '@/db/with-actor';
import { createDraftArticle } from '@/modules/hdk/api/articles';
import { saveSolutionDraft, solutionEditorState } from '@/modules/hdk/api/editor';
import { archiveSolution, publishSolution } from '@/modules/hdk/api/publish';
import { articleByNumberTx } from '@/modules/hdk/core/editor';
import { publishTx } from '@/modules/hdk/core/publish';
import { MemoryJobQueue, setJobQueueForTests } from '@/modules/hdc/testing';
import { staffCtx, staffWithRole } from './helpers/auth';
import { pools } from './helpers/db';
import { type Fixture, seedTwoOrgs } from './isolation/fixture';

// Повторная проверка M5 (docs/decisions/0057): гонки публикации с автосохранением, возврат из архива и переводы.

let f: Fixture;
let moduleId: string;

const p = (id: string, text: string) => ({ type: 'paragraph' as const, attrs: { id }, content: [{ type: 'text' as const, text }] });
const step = (id: string, text: string) => ({ type: 'step' as const, attrs: { id }, content: [p(`${id}p`, text)] });
const doc = (...blocks: object[]) => ({ version: 1 as const, blocks });
const READY = doc(p('pwhat00001', 'Остаток не списывается при проведении'), step('step000001', 'Откройте раздел Склад'));
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

beforeEach(async () => {
  f = await seedTwoOrgs();
  setJobQueueForTests(new MemoryJobQueue());
  moduleId = (await pools.root.query(`insert into hdr_product_modules (code, name) values ('rf-${Date.now()}-${Math.random()}', '{"ru": "Склад"}') returning module_id`)).rows[0]
    .module_id as string;
  await pools.root.query(`delete from hdc_settings where code = 'kb.allowed_domains'`);
  await pools.root.query(`insert into hdc_settings (code, value) values ('kb.allowed_domains', '["smartup.uz"]')`);
});
afterEach(() => setJobQueueForTests(null));

const l2 = () => staffWithRole('agent_l2').then(staffCtx);

async function draft(content = READY) {
  const created = await createDraftArticle(staffCtx(f.l1), { locale: 'ru', title: 'Остаток не списывается', audience: 'clients', moduleId, doc: content });
  return { ...created, ...(await current(created.number)) };
}
async function current(number: number, locale: 'ru' | 'uz' | 'en' = 'ru') {
  const state = await solutionEditorState(staffCtx(f.l1), { number, locale });
  if (!state) throw new Error('нет решения');
  return { versionId: state.current.versionId, revision: state.current.revision, state };
}

test('C1: автосохранение между чтением и публикацией не оставляет версию published с непроверенным текстом', async () => {
  const d = await draft();
  const ctx = await l2();
  // Вторая вкладка сохраняет черновик (телефон в тексте), пока публикация уже идёт.
  const other = await pools.root.connect();
  try {
    await other.query('begin');
    await other.query(`update hdk_article_versions set doc = $1 where version_id = $2`, [doc(p('pwhat00001', 'Позвоните +998 90 123 45 67'), step('step000001', 'Откройте раздел Склад')), d.versionId]);
    const publishing = publishSolution(ctx, { number: d.number, locale: 'ru', versionId: d.versionId, revision: d.revision, confirmFindings: false });
    await sleep(1500);
    await other.query('commit');
    expect(await publishing).toEqual({ status: 'conflict' });
  } finally {
    other.release();
  }
  const version = (await pools.root.query(`select state, doc from hdk_article_versions where version_id = $1`, [d.versionId])).rows[0];
  expect(version.state).toBe('draft');
  expect(JSON.stringify(version.doc)).toContain('+998 90 123 45 67');
  expect((await pools.root.query(`select 1 from hdk_published where article_id = $1`, [d.articleId])).rowCount).toBe(0);
});

test('C1: сохранение ждёт идущую публикацию той же статьи и получает конфликт, а не черновик на прежнем тексте', async () => {
  const d = await draft();
  const ctx = await l2();
  await publishSolution(ctx, { number: d.number, locale: 'ru', versionId: d.versionId, revision: d.revision, confirmFindings: false });
  const v1 = await current(d.number);
  // Черновик версии 2 и его публикация, которая держит транзакцию открытой.
  const saved = await saveSolutionDraft(staffCtx(f.l1), { number: d.number, locale: 'ru', versionId: v1.versionId, revision: v1.revision, title: 'Версия 2', doc: READY });
  if (saved.status !== 'saved') throw new Error('не сохранено');
  let committedAt = 0;
  const publishing = withActor(ctx.actor, async (tx) => {
    const article = (await articleByNumberTx(tx, d.number, { lock: true }))!;
    const outcome = await publishTx(tx, article, { locale: 'ru', versionId: saved.versionId, revision: saved.revision, confirmFindings: false, allowedDomains: ['smartup.uz'] });
    await sleep(1500);
    committedAt = Date.now();
    return outcome;
  });
  await sleep(300);
  // Вкладка, открытая на версии 1, сохраняет правку от неё.
  const late = await saveSolutionDraft(staffCtx(f.l1), { number: d.number, locale: 'ru', versionId: v1.versionId, revision: v1.revision, title: 'Правка версии 1', doc: READY });
  const savedAt = Date.now();
  expect((await publishing).status).toBe('published');
  expect(late).toEqual({ status: 'conflict' });
  // Сохранение дождалось конца публикации: чтение основы и проверка черновика идут уже после неё.
  expect(savedAt).toBeGreaterThanOrEqual(committedAt);
  expect((await pools.root.query(`select count(*)::int as n from hdk_article_versions where article_id = $1 and state = 'draft'`, [d.articleId])).rows[0].n).toBe(0);
});

test('M3m: возврат из архива со старой страницы при черновике архивного решения даёт конфликт, а не ошибку', async () => {
  const d = await draft();
  const ctx = await l2();
  await publishSolution(ctx, { number: d.number, locale: 'ru', versionId: d.versionId, revision: d.revision, confirmFindings: false });
  const published = await current(d.number);
  await archiveSolution(ctx, { number: d.number });
  // В другой вкладке начали правку архивного решения: появился черновик.
  const edit = await saveSolutionDraft(staffCtx(f.l1), { number: d.number, locale: 'ru', versionId: published.versionId, revision: published.revision, title: 'Правка', doc: READY });
  expect(edit.status).toBe('saved');
  // Старая страница возвращает из архива опубликованную версию.
  expect(await publishSolution(ctx, { number: d.number, locale: 'ru', versionId: published.versionId, revision: published.revision, confirmFindings: false })).toEqual({ status: 'conflict' });
  expect((await pools.root.query(`select status from hdk_articles where article_id = $1`, [d.articleId])).rows[0].status).toBe('archived');
});
