import { afterEach, beforeEach, expect, test } from 'vitest';
import type { SystemActor } from '@/db/with-actor';
import { setLogSinkForTests } from '@/lib/log';
import { MemoryJobQueue, setJobQueueForTests } from '@/modules/hdc/testing';
import { createDraftArticle } from '@/modules/hdk/api/articles';
import { saveSolutionDraft, saveSolutionMeta, solutionEditorState } from '@/modules/hdk/api/editor';
import { createSolutionFromTicket } from '@/modules/hdk/api/from-ticket';
import { archiveSolution, publishSolution } from '@/modules/hdk/api/publish';
import { reconcileSearchIndex, runIndexJob } from '@/modules/hdk/api/search-jobs';
import { type EmbeddingProvider, EmbeddingUnavailableError, setEmbedderForTests } from '@/modules/hdk/embeddings';
import { createStubEmbedder } from '@/modules/hdk/embeddings/stub';
import { clientCtx, staffCtx, staffWithRole } from './helpers/auth';
import { asActor, pools } from './helpers/db';
import { type Fixture, seedTwoOrgs } from './isolation/fixture';

// Поисковый индекс подсказки (план M5, задача 9; ТЗ 10.4, 11.11, решения 5, 11). Строка на пару "решение + язык" только
// из копии для читателей; архивное и внутреннее решение в индекс клиента не попадает; текст обращения не попадает в
// индекс никогда; сбой сервиса векторов не теряет документ (повтор задачи и ночная сверка).

const SYSTEM: SystemActor = { type: 'system', job: 'kb.index' };
let f: Fixture;
let jobs: MemoryJobQueue;
let moduleId: string;
let serial = 0;
const newId = () => `idx${String(++serial).padStart(9, '0')}`;

const p = (id: string, text: string) => ({ type: 'paragraph' as const, attrs: { id }, content: [{ type: 'text' as const, text }] });
const step = (id: string, text: string) => ({ type: 'step' as const, attrs: { id }, content: [p(`${id}p`, text)] });
const doc = (what: string, todo: string) => ({ version: 1 as const, blocks: [p(newId(), what), step(newId(), todo)] });

beforeEach(async () => {
  f = await seedTwoOrgs();
  jobs = new MemoryJobQueue();
  setJobQueueForTests(jobs);
  setEmbedderForTests(createStubEmbedder());
  moduleId = (await pools.root.query(`insert into hdr_product_modules (code, name) values ('idx-${Date.now()}-${Math.random()}', '{"ru": "Склад"}') returning module_id`)).rows[0].module_id as string;
  await pools.root.query(`delete from hdk_search_documents`);
  await pools.root.query(`delete from hdc_settings where code = 'kb.allowed_domains'`);
  await pools.root.query(`insert into hdc_settings (code, value) values ('kb.allowed_domains', '["smartup.uz"]')`);
});
afterEach(() => {
  setJobQueueForTests(null);
  setEmbedderForTests(null);
  setLogSinkForTests(null);
});

/** Опубликованное решение: черновик пишет первая линия, публикует вторая. */
async function published(title: string, what: string, todo: string, audience: 'clients' | 'internal' = 'clients') {
  const created = await createDraftArticle(staffCtx(f.l1), { locale: 'ru', title, audience, moduleId, doc: doc(what, todo) });
  const state = await solutionEditorState(staffCtx(f.l1), { number: created.number });
  const l2 = staffCtx(await staffWithRole('agent_l2'));
  const outcome = await publishSolution(l2, { number: created.number, locale: 'ru', versionId: state!.current.versionId, revision: state!.current.revision, confirmFindings: false });
  expect(outcome.status).toBe('published');
  return { ...created, l2 };
}
const rowsOf = (articleId: string) =>
  pools.root.query(`select locale, audience, title, body_text, module_id, published_id, tsv is not null as has_tsv, embedding is not null as has_vector, vector_dims(embedding) as dims from hdk_search_documents where ref_id = $1`, [articleId]).then((r) => r.rows);
const clientRows = async (articleId: string) =>
  asActor(pools.app, (await clientCtx(f.aUser)).actor, async (c) => (await c.query(`select search_document_id from hdk_search_documents where ref_id = $1`, [articleId])).rowCount);

test('kb.index: строка на язык из копии для читателей, tsv по языку, вектор 1024, модуль статьи', async () => {
  const a = await published('Заказ не сохраняется: нет остатка', 'При сохранении заказа выходит ошибка остатка', 'Откройте Склад, затем Остатки');
  expect(jobs.sent).toContainEqual({ name: 'kb.index', data: { articleId: a.articleId } });
  expect(await runIndexJob(SYSTEM, { articleId: a.articleId })).toEqual({ indexed: 1, removed: 0, embedded: 1 });
  const copy = (await pools.root.query(`select published_id, body_text from hdk_published where article_id = $1`, [a.articleId])).rows[0];
  expect(await rowsOf(a.articleId)).toEqual([
    {
      locale: 'ru',
      audience: 'clients',
      title: 'Заказ не сохраняется: нет остатка',
      body_text: copy.body_text,
      module_id: moduleId,
      published_id: copy.published_id,
      has_tsv: true,
      has_vector: true,
      dims: 1024,
    },
  ]);
  // Русская конфигурация: форма слова находит документ ("остатки" и "остатка" дают одну основу).
  const found = await pools.root.query(`select 1 from hdk_search_documents where ref_id = $1 and tsv @@ plainto_tsquery('russian', 'остатки складов')`, [a.articleId]);
  expect(found.rowCount).toBe(1);
  // Повтор задачи ничего не пересчитывает.
  expect(await runIndexJob(SYSTEM, { articleId: a.articleId })).toEqual({ indexed: 1, removed: 0, embedded: 0 });
  expect(await clientRows(a.articleId)).toBe(1);
});

test('архивное решение уходит из индекса, повтор задачи после архива строку не возвращает', async () => {
  const a = await published('Отчёт по продажам пустой', 'Отчёт по продажам не показывает строки', 'Проверьте период отчёта');
  await runIndexJob(SYSTEM, { articleId: a.articleId });
  await archiveSolution(a.l2, { number: a.number });
  expect(await rowsOf(a.articleId)).toEqual([]);
  expect(await runIndexJob(SYSTEM, { articleId: a.articleId })).toEqual({ indexed: 0, removed: 0, embedded: 0 });
  expect(await rowsOf(a.articleId)).toEqual([]);
  expect((await reconcileSearchIndex(SYSTEM)).articles).toBe(0);
  expect(await rowsOf(a.articleId)).toEqual([]);
});

test('внутреннее решение и сужение аудитории: сотрудник находит, клиент нет', async () => {
  const inner = await published('Сброс очереди обмена', 'Обмен с кассой завис', 'Перезапустите службу обмена', 'internal');
  await runIndexJob(SYSTEM, { articleId: inner.articleId });
  expect((await rowsOf(inner.articleId)).map((r) => r.audience)).toEqual(['internal']);
  expect(await clientRows(inner.articleId)).toBe(0);
  const staffSees = await asActor(pools.app, f.l1.actor, async (c) => (await c.query(`select 1 from hdk_search_documents where ref_id = $1`, [inner.articleId])).rowCount);
  expect(staffSees).toBe(1);

  const open = await published('Печать накладной обрезана', 'Накладная печатается не целиком', 'Выберите формат A4');
  await runIndexJob(SYSTEM, { articleId: open.articleId });
  expect(await clientRows(open.articleId)).toBe(1);
  await saveSolutionMeta(staffCtx(f.l1), { number: open.number, moduleId, audience: 'internal' });
  expect((await rowsOf(open.articleId)).map((r) => r.audience)).toEqual(['internal']);
  expect(await clientRows(open.articleId)).toBe(0);
});

test('смена модуля ставит kb.index, строка получает новый модуль', async () => {
  const a = await published('Не приходит СМС', 'Код из СМС не приходит', 'Проверьте номер телефона в профиле');
  await runIndexJob(SYSTEM, { articleId: a.articleId });
  const other = (await pools.root.query(`insert into hdr_product_modules (code, name) values ('idx2-${Date.now()}', '{"ru": "Касса"}') returning module_id`)).rows[0].module_id as string;
  jobs.sent.length = 0;
  await saveSolutionMeta(staffCtx(f.l1), { number: a.number, moduleId: other, audience: 'clients' });
  expect(jobs.sent).toEqual([{ name: 'kb.index', data: { articleId: a.articleId } }]);
  await runIndexJob(SYSTEM, { articleId: a.articleId });
  expect((await rowsOf(a.articleId))[0].module_id).toBe(other);
});

test('текст обращения не попадает в индекс никогда: решение из обращения индексируется только своим текстом', async () => {
  const { ticketId, number } = f.tickets.aOrg;
  const secret = 'Квазиморфный шпиндель Зюзякина';
  await pools.root.query(`update hdt_tickets set status = 'resolved', module_id = $3, description = $2 where ticket_id = $1`, [ticketId, `${secret}: описание клиента`, moduleId]);
  await pools.root.query(`insert into hdt_ticket_messages (org_id, ticket_id, author_id, author_type, body, is_internal) values ($1, $2, $3, 'client', $4, false)`, [f.orgA.orgId, ticketId, f.aUser.userId, `${secret} снова`]);
  await pools.root.query(`insert into hdt_ticket_messages (org_id, ticket_id, author_id, author_type, body, is_internal) values ($1, $2, $3, 'staff', $4, true)`, [f.orgA.orgId, ticketId, f.l1.userId, `${secret}: внутренняя заметка`]);
  const labels = () => ({ what: 'Что видит пользователь', why: 'Почему так происходит', do: 'Что сделать' });
  const created = await createSolutionFromTicket(staffCtx(f.l1), { number }, labels, newId);
  const state = await solutionEditorState(staffCtx(f.l1), { number: created.number });
  const saved = await saveSolutionDraft(staffCtx(f.l1), {
    number: created.number,
    locale: state!.locale,
    versionId: state!.current.versionId,
    revision: state!.current.revision,
    title: 'Документ не проводится',
    doc: doc('Документ не проводится из-за закрытого периода', 'Откройте настройки периода'),
  });
  if (saved.status !== 'saved') throw new Error('черновик не сохранён');
  const l2 = staffCtx(await staffWithRole('agent_l2'));
  expect((await publishSolution(l2, { number: created.number, locale: state!.locale, versionId: saved.versionId, revision: saved.revision, confirmFindings: false })).status).toBe('published');
  const articleId = state!.articleId;
  await runIndexJob(SYSTEM, { articleId });
  await reconcileSearchIndex(SYSTEM);
  const leaked = await pools.root.query(`select 1 from hdk_search_documents where title ilike '%Зюзякин%' or body_text ilike '%Зюзякин%' or tsv @@ plainto_tsquery('russian', 'Зюзякина')`);
  expect(leaked.rowCount).toBe(0);
  // Каждая строка индекса повторяет копию для читателей: другого источника текста у индекса нет.
  const mismatch = await pools.root.query(
    `select d.search_document_id from hdk_search_documents d left join hdk_published p on p.published_id = d.published_id
      where p.published_id is null or p.title <> d.title or p.body_text <> d.body_text`,
  );
  expect(mismatch.rowCount).toBe(0);
  expect((await rowsOf(articleId)).length).toBe(1);
});

test('сервис векторов недоступен: строка с текстом есть, задача бросает для повтора, сверка досчитывает вектор', async () => {
  const events: [string, string, Record<string, unknown>][] = [];
  setLogSinkForTests((level, event, fields) => events.push([level, event, fields ?? {}]));
  const down: EmbeddingProvider = { name: 'tei', dimensions: 1024, embed: async () => Promise.reject(new EmbeddingUnavailableError('timeout')) };
  setEmbedderForTests(down);
  const a = await published('Касса не печатает чек', 'Чек не печатается после оплаты', 'Проверьте подключение принтера');
  await expect(runIndexJob(SYSTEM, { articleId: a.articleId })).rejects.toBeInstanceOf(EmbeddingUnavailableError);
  expect(await rowsOf(a.articleId)).toMatchObject([{ has_tsv: true, has_vector: false }]);
  expect(events).toContainEqual(['warn', 'kb.index_embedding_unavailable', { articleId: a.articleId, reason: 'timeout' }]);
  // В журнал не попадает текст решения.
  expect(JSON.stringify(events)).not.toContain('Чек не печатается');
  setEmbedderForTests(createStubEmbedder());
  const result = await reconcileSearchIndex(SYSTEM);
  expect(result.failed).toBe(0);
  expect(result.articles).toBeGreaterThanOrEqual(1);
  expect(await rowsOf(a.articleId)).toMatchObject([{ has_vector: true, dims: 1024 }]);
});

test('сверка: опубликованное без строки индекса индексируется, исходы старше 13 месяцев удаляются', async () => {
  const a = await published('Не открывается отчёт остатков', 'Отчёт остатков не открывается', 'Обновите страницу');
  expect(await rowsOf(a.articleId)).toEqual([]);
  // Время создания ставит триггер служебных колонок: строки прошлого вставляются без триггеров.
  const client = await pools.root.connect();
  let old: { rows: { deflection_event_id: string }[] };
  try {
    await client.query('begin');
    await client.query('set local session_replication_role = replica');
    old = await client.query(
      `insert into hdk_deflection_events (org_id, user_id, session_id, query_hash, created_on) values ($1, $2, uuidv7(), repeat('a', 64), now() - interval '14 months'), ($1, $2, uuidv7(), repeat('b', 64), now() - interval '12 months') returning deflection_event_id`,
      [f.orgA.orgId, f.aUser.userId],
    );
    await client.query('commit');
  } finally {
    client.release();
  }
  const result = await reconcileSearchIndex(SYSTEM);
  expect(result.deflections).toBeGreaterThanOrEqual(1);
  expect(await rowsOf(a.articleId)).toMatchObject([{ has_vector: true }]);
  const left = await pools.root.query(`select deflection_event_id from hdk_deflection_events where deflection_event_id = any($1::uuid[])`, [old.rows.map((r) => r.deflection_event_id)]);
  expect(left.rows.map((r) => r.deflection_event_id)).toEqual([old.rows[1].deflection_event_id]);
});

test('колонку tsv приложение не подменяет: триггер пересчитывает её из текста', async () => {
  const a = await published('Ошибка обмена с банком', 'Выписка банка не загружается', 'Проверьте ключ банка');
  await runIndexJob(SYSTEM, { articleId: a.articleId });
  await asActor(pools.app, SYSTEM, (c) => c.query(`update hdk_search_documents set tsv = to_tsvector('simple', 'подмена') where ref_id = $1`, [a.articleId]));
  const tsv = await pools.root.query(`select tsv @@ plainto_tsquery('russian', 'выписки') as real, tsv @@ plainto_tsquery('simple', 'подмена') as fake from hdk_search_documents where ref_id = $1`, [a.articleId]);
  expect(tsv.rows[0]).toEqual({ real: true, fake: false });
});

test('сверка находит строку индекса со старым модулем: смена модуля, чья задача kb.index потерялась (0057, I2c)', async () => {
  const a = await published('Не печатается чек', 'Чек не печатается', 'Перезапустите кассу');
  await runIndexJob(SYSTEM, { articleId: a.articleId });
  const other = (await pools.root.query(`insert into hdr_product_modules (code, name) values ('idx3-${Date.now()}', '{"ru": "Касса"}') returning module_id`)).rows[0].module_id as string;
  await saveSolutionMeta(staffCtx(f.l1), { number: a.number, moduleId: other, audience: 'clients' });
  // Задача из очереди не выполнилась: сверка должна найти расхождение сама.
  const result = await reconcileSearchIndex(SYSTEM);
  expect(result.articles).toBe(1);
  expect((await rowsOf(a.articleId))[0].module_id).toBe(other);
});
