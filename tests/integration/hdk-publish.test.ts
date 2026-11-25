import { afterEach, beforeEach, expect, test } from 'vitest';
import { createDraftArticle } from '@/modules/hdk/api/articles';
import { clientSolutionFileResponse, clientSolutionPage, recordSolutionFeedback } from '@/modules/hdk/api/client';
import { saveSolutionDraft, saveSolutionMeta, solutionEditorState } from '@/modules/hdk/api/editor';
import { allowedDomainsSetting, archiveSolution, markSolutionTextRead, publishSolution, readAllowedDomains, saveAllowedDomains } from '@/modules/hdk/api/publish';
import { MemoryJobQueue, MemoryStorage, setJobQueueForTests, setStorageForTests } from '@/modules/hdc/testing';
import { clientCtx, staffCtx, staffWithRole } from './helpers/auth';
import { asActor, pools } from './helpers/db';
import { type Fixture, seedTwoOrgs } from './isolation/fixture';

// Проверка, публикация, архив и страница клиента (план M5, задача 4; FR-SOL-02, 04, 05, 17, ТЗ 18.10, UX-W-07;
// решения 9-12, 15, 16). "На что смотреть при проверке", пункт 1: клиент не читает черновик, версию, перевод в работе,
// внутреннее решение и файл ни страницей, ни подбором номера, ни файлом. Пункт 2 в части задачи 4: текст модели до
// клиента не доходит без публикации сотрудником.

let f: Fixture;
let jobs: MemoryJobQueue;
let storage: MemoryStorage;
let moduleId: string;

const p = (id: string, text?: string, marks?: object[]) => ({
  type: 'paragraph' as const,
  attrs: { id },
  ...(text ? { content: [{ type: 'text' as const, text, ...(marks ? { marks } : {}) }] } : {}),
});
const step = (id: string, text: string, extra: object[] = []) => ({ type: 'step' as const, attrs: { id }, content: [p(`${id}p`, text), ...extra] });
const doc = (...blocks: object[]) => ({ version: 1 as const, blocks });
const READY = doc(p('pwhat00001', 'Остаток не списывается при проведении'), step('step000001', 'Откройте раздел Склад'));
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);

beforeEach(async () => {
  f = await seedTwoOrgs();
  jobs = new MemoryJobQueue();
  setJobQueueForTests(jobs);
  storage = new MemoryStorage();
  setStorageForTests(storage);
  moduleId = (await pools.root.query(`insert into hdr_product_modules (code, name) values ('warehouse-${Date.now()}', '{"ru": "Склад"}') returning module_id`)).rows[0]
    .module_id as string;
  await pools.root.query(`delete from hdc_settings where code = 'kb.allowed_domains'`);
  await pools.root.query(`insert into hdc_settings (code, value) values ('kb.allowed_domains', '["smartup.uz"]')`);
  await pools.root.query(`delete from hdc_rate_limits where code like 'kb-feedback%'`);
});
afterEach(() => {
  setJobQueueForTests(null);
  setStorageForTests(null);
});

const l2 = () => staffWithRole('agent_l2').then(staffCtx);

/** Черновик с текстом: создаёт первая линия, текст сохраняется автосохранением. */
async function draft(content = READY, title = 'Остаток не списывается', opts: { audience?: 'clients' | 'internal'; withModule?: boolean } = {}) {
  const created = await createDraftArticle(staffCtx(f.l1), {
    locale: 'ru',
    title,
    audience: opts.audience ?? 'clients',
    ...(opts.withModule === false ? {} : { moduleId }),
    doc: content,
  });
  return { ...created, ...(await current(created.number)) };
}
async function current(number: number) {
  const state = await solutionEditorState(staffCtx(f.l1), { number });
  if (!state) throw new Error('нет решения');
  return { versionId: state.current.versionId, revision: state.current.revision, state };
}
const publishInput = (d: { number: number; versionId: string; revision: string }, confirmFindings = false) => ({
  number: d.number,
  locale: 'ru',
  versionId: d.versionId,
  revision: d.revision,
  confirmFindings,
});

test('публикация одной транзакцией: версия published, копия для читателей, адрес, журнал, задача индекса после фиксации', async () => {
  const d = await draft();
  const ctx = await l2();
  expect(await publishSolution(ctx, publishInput(d))).toEqual({ status: 'published', versionNumber: 1 });
  const version = await pools.root.query(`select state from hdk_article_versions where version_id = $1`, [d.versionId]);
  expect(version.rows[0].state).toBe('published');
  const copy = (await pools.root.query(`select * from hdk_published where article_id = $1`, [d.articleId])).rows[0];
  expect(copy).toMatchObject({
    locale: 'ru',
    audience: 'clients',
    title: 'Остаток не списывается',
    slug: 'ostatok-ne-spisyvaetsya',
    module_ids: [moduleId],
    is_machine: false,
    is_outdated: false,
  });
  expect(copy.body_text).toBe('Остаток не списывается при проведении\nОткройте раздел Склад');
  const translation = (await pools.root.query(`select * from hdk_article_translations where article_id = $1`, [d.articleId])).rows[0];
  expect(translation).toMatchObject({ published_version_id: d.versionId, draft_version_id: null, slug: 'ostatok-ne-spisyvaetsya', status: 'reviewed' });
  const audit = await pools.root.query(`select diff from hdc_audit_log where action = 'solution.published' and object_id = $1`, [d.articleId]);
  expect(audit.rows[0].diff).toMatchObject({ number: d.number, locale: 'ru', version: 1 });
  expect(jobs.sent).toEqual([{ name: 'kb.index', data: { articleId: d.articleId } }]);
});

test('публикуют только agent_l2, care и admin: первая линия и product получают отказ в коде и в базе', async () => {
  const d = await draft();
  for (const role of ['agent_l1', 'product'] as const)
    await expect(publishSolution(staffCtx(await staffWithRole(role)), publishInput(d))).rejects.toMatchObject({ code: 'forbidden' });
  await expect(publishSolution(staffCtx(f.l1), publishInput(d))).rejects.toMatchObject({ code: 'forbidden' });
  await expect(archiveSolution(staffCtx(f.l1), { number: d.number })).rejects.toMatchObject({ code: 'forbidden' });
  // Политики: первая линия не делает версию опубликованной и не пишет копию.
  const versionUpdate = await asActor(pools.app, f.l1.actor, (c) => c.query(`update hdk_article_versions set state = 'published' where version_id = $1`, [d.versionId])).catch(
    (e: Error) => e,
  );
  expect(versionUpdate instanceof Error ? versionUpdate.message : versionUpdate.rowCount).toMatch(/row-level security|^0$/);
  const insert = await asActor(pools.app, f.l1.actor, (c) =>
    c.query(
      `insert into hdk_published (article_id, article_number, locale, version_id, audience, title, doc, body_text, slug, original_locale) values ($1, $2, 'ru', $3, 'clients', 't', $4, 't', 't', 'ru')`,
      [d.articleId, d.number, d.versionId, READY],
    ),
  ).catch((e: Error) => e);
  expect(String(insert)).toMatch(/row-level security/);
  // Care и admin публикуют.
  expect((await publishSolution(staffCtx(f.care), publishInput(d))).status).toBe('published');
  expect(jobs.sent).toHaveLength(1);
});

test('панель готовности: без модуля и шагов не публикуется, находки требуют подтверждения, ссылка вне списка не публикуется никогда', async () => {
  const ctx = await l2();
  const bare = await draft(doc(p('pwhat00001', 'Текст без шагов')), 'Без шагов', { withModule: false });
  const notReady = await publishSolution(ctx, publishInput(bare, true));
  expect(notReady).toMatchObject({ status: 'not_ready', readiness: { items: { module: false, steps: false }, ready: false } });

  const phone = await draft(doc(p('pwhat00001', 'Позвоните +998 90 123 45 67'), step('step000001', 'Откройте Склад')), 'С телефоном');
  const unconfirmed = await publishSolution(ctx, publishInput(phone));
  expect(unconfirmed).toMatchObject({ status: 'not_ready', readiness: { ready: true, needsConfirm: true }, findings: [{ kind: 'phone', blockId: 'pwhat00001' }] });
  expect((await pools.root.query(`select 1 from hdk_published where article_id = $1`, [phone.articleId])).rowCount).toBe(0);
  const confirmed = await publishSolution(ctx, publishInput(phone, true));
  expect(confirmed.status).toBe('published');
  const audit = await pools.root.query(`select diff from hdc_audit_log where action = 'solution.published' and object_id = $1`, [phone.articleId]);
  expect(audit.rows[0].diff).toMatchObject({ findingsConfirmed: 1 });

  const link = await draft(doc(p('plink00001', 'документация', [{ type: 'link', attrs: { href: 'https://evil.example/x' } }]), step('step000001', 'Откройте Склад')), 'Со ссылкой');
  expect(await publishSolution(ctx, publishInput(link, true))).toMatchObject({
    status: 'not_ready',
    readiness: { blocked: true },
    findings: [{ kind: 'link', text: 'evil.example', blocking: true }],
  });
  expect((await pools.root.query(`select 1 from hdk_published where article_id = $1`, [link.articleId])).rowCount).toBe(0);
  // Разрешённый домен публикуется.
  const allowed = await draft(
    doc(p('plink00001', 'справка', [{ type: 'link', attrs: { href: 'https://docs.smartup.uz/stock' } }]), step('step000001', 'Откройте Склад')),
    'С разрешённой ссылкой',
  );
  expect((await publishSolution(ctx, publishInput(allowed))).status).toBe('published');
});

test('устаревшая версия строки не публикуется: сотрудник публикует только то, что видел', async () => {
  const d = await draft();
  const saved = await saveSolutionDraft(staffCtx(f.l1), { number: d.number, locale: 'ru', versionId: d.versionId, revision: d.revision, title: 'Новый заголовок', doc: READY });
  expect(saved.status).toBe('saved');
  expect(await publishSolution(await l2(), publishInput(d))).toEqual({ status: 'conflict' });
});

test('текст от модели: публикация требует отметки "Текст прочитан", отметка в журнале', async () => {
  const d = await draft();
  await pools.root.query(`update hdk_article_versions set is_machine = true where version_id = $1`, [d.versionId]);
  const machine = await current(d.number);
  const ctx = await l2();
  expect(await publishSolution(ctx, publishInput({ number: d.number, ...machine }, true))).toMatchObject({ status: 'not_ready', readiness: { items: { textRead: false } } });
  const read = await markSolutionTextRead(staffCtx(f.l1), { number: d.number, locale: 'ru', versionId: machine.versionId, revision: machine.revision });
  expect(read.status).toBe('read');
  const audit = await pools.root.query(`select diff from hdc_audit_log where action = 'solution.text_read' and object_id = $1`, [d.articleId]);
  expect(audit.rows[0].diff).toMatchObject({ number: d.number, version: 1 });
  if (read.status !== 'read') throw new Error('не отмечено');
  expect((await publishSolution(ctx, publishInput({ number: d.number, versionId: machine.versionId, revision: read.revision }))).status).toBe('published');
});

test('новая публикация: прежняя версия superseded, переводы оригинала outdated и копия перевода с пометкой', async () => {
  const d = await draft();
  const ctx = await l2();
  await publishSolution(ctx, publishInput(d));
  // Перевод на узбекский (задача 6) уже опубликован: строки под суперпользователем.
  const uz = (
    await pools.root.query(
      `insert into hdk_article_versions (article_id, locale, number, title, doc, state) values ($1, 'uz', 1, 'Qoldiq', $2, 'published') returning version_id`,
      [d.articleId, READY],
    )
  ).rows[0].version_id as string;
  await pools.root.query(`insert into hdk_article_translations (article_id, locale, published_version_id, slug, status) values ($1, 'uz', $2, 'qoldiq', 'reviewed')`, [
    d.articleId,
    uz,
  ]);
  await pools.root.query(
    `insert into hdk_published (article_id, article_number, locale, version_id, audience, title, doc, body_text, slug, original_locale) values ($1, $2, 'uz', $3, 'clients', 'Qoldiq', $4, 'x', 'qoldiq', 'ru')`,
    [d.articleId, d.number, uz, READY],
  );
  const published = await current(d.number);
  const saved = await saveSolutionDraft(staffCtx(f.l1), {
    number: d.number,
    locale: 'ru',
    versionId: published.versionId,
    revision: published.revision,
    title: 'Остаток не списывается, версия 2',
    doc: READY,
  });
  if (saved.status !== 'saved') throw new Error('не сохранено');
  expect(await publishSolution(ctx, { number: d.number, locale: 'ru', versionId: saved.versionId, revision: saved.revision, confirmFindings: false })).toEqual({
    status: 'published',
    versionNumber: 2,
  });
  const states = await pools.root.query(`select number, state from hdk_article_versions where article_id = $1 and locale = 'ru' order by number`, [d.articleId]);
  expect(states.rows).toEqual([
    { number: 1, state: 'superseded' },
    { number: 2, state: 'published' },
  ]);
  expect((await pools.root.query(`select status from hdk_article_translations where article_id = $1 and locale = 'uz'`, [d.articleId])).rows[0].status).toBe('outdated');
  const copies = await pools.root.query(`select locale, title, is_outdated from hdk_published where article_id = $1 order by locale`, [d.articleId]);
  expect(copies.rows).toEqual([
    { locale: 'ru', title: 'Остаток не списывается, версия 2', is_outdated: false },
    { locale: 'uz', title: 'Qoldiq', is_outdated: true },
  ]);
});

test('сбой посреди публикации не оставляет ничего: ни версии, ни копии, ни журнала, ни задачи', async () => {
  const d = await draft();
  await pools.root.query(`create function pg_temp_fail() returns trigger language plpgsql as $$ begin raise exception 'сбой посреди публикации'; end $$`);
  await pools.root.query(`create trigger t_test_fail before insert on hdk_published for each row execute function pg_temp_fail()`);
  try {
    await expect(publishSolution(await l2(), publishInput(d))).rejects.toThrow(/сбой посреди публикации/);
  } finally {
    await pools.root.query(`drop trigger t_test_fail on hdk_published`);
    await pools.root.query(`drop function pg_temp_fail()`);
  }
  expect((await pools.root.query(`select state from hdk_article_versions where article_id = $1`, [d.articleId])).rows).toEqual([{ state: 'draft' }]);
  expect((await pools.root.query(`select published_version_id, draft_version_id from hdk_article_translations where article_id = $1`, [d.articleId])).rows[0]).toEqual({
    published_version_id: null,
    draft_version_id: d.versionId,
  });
  expect((await pools.root.query(`select 1 from hdk_published where article_id = $1`, [d.articleId])).rowCount).toBe(0);
  expect((await pools.root.query(`select 1 from hdc_audit_log where action = 'solution.published' and object_id = $1`, [d.articleId])).rowCount).toBe(0);
  expect(jobs.sent).toEqual([]);
});

test('архив: копия и строки индекса уходят, клиент видит "больше не действует", возврат это новая публикация', async () => {
  const d = await draft();
  const ctx = await l2();
  await publishSolution(ctx, publishInput(d));
  await pools.root.query(
    `insert into hdk_search_documents (published_id, kind, article_type, ref_id, locale, title, body_text, audience) select published_id, 'article', 'solution', article_id, locale, title, body_text, audience from hdk_published where article_id = $1`,
    [d.articleId],
  );
  const client = await clientCtx(f.aUser);
  expect((await clientSolutionPage(client, { ref: String(d.number), locale: 'ru' }))?.kind).toBe('solution');
  await archiveSolution(ctx, { number: d.number });
  expect((await pools.root.query(`select status, archived_on is not null as archived from hdk_articles where article_id = $1`, [d.articleId])).rows[0]).toEqual({
    status: 'archived',
    archived: true,
  });
  expect((await pools.root.query(`select 1 from hdk_published where article_id = $1`, [d.articleId])).rowCount).toBe(0);
  expect((await pools.root.query(`select 1 from hdk_search_documents where ref_id = $1`, [d.articleId])).rowCount).toBe(0);
  expect((await pools.root.query(`select 1 from hdc_audit_log where action = 'solution.archived' and object_id = $1`, [d.articleId])).rowCount).toBe(1);
  expect(await clientSolutionPage(client, { ref: `${d.number}-ostatok-ne-spisyvaetsya`, locale: 'ru' })).toEqual({ kind: 'archived', number: d.number });
  await expect(archiveSolution(ctx, { number: d.number })).rejects.toMatchObject({ code: 'invalid_input' });
  // Архивное решение не правится как действующее: модуль и видимость закрыты.
  await expect(saveSolutionMeta(staffCtx(f.l1), { number: d.number, moduleId, audience: 'internal' })).rejects.toMatchObject({ code: 'forbidden' });
  // Возврат: публикация последней опубликованной версии создаёт новую версию.
  const archived = await current(d.number);
  expect(archived.state.archived).toBe(true);
  expect(await publishSolution(ctx, publishInput({ number: d.number, ...archived }))).toEqual({ status: 'published', versionNumber: 2 });
  expect((await clientSolutionPage(client, { ref: String(d.number), locale: 'ru' }))?.kind).toBe('solution');
});

test('клиент не читает черновик, внутреннее решение и прежнюю версию: ни страницей, ни подбором номера', async () => {
  const client = await clientCtx(f.bUser);
  const draftOnly = await draft(READY, 'Только черновик');
  expect(await clientSolutionPage(client, { ref: String(draftOnly.number), locale: 'ru' })).toBeNull();
  const internal = await draft(READY, 'Только через сотрудника', { audience: 'internal' });
  await publishSolution(await l2(), publishInput(internal));
  expect(await clientSolutionPage(client, { ref: String(internal.number), locale: 'ru' })).toBeNull();
  // Архивное внутреннее решение не раскрывается и страницей "больше не действует".
  await archiveSolution(await l2(), { number: internal.number });
  expect(await clientSolutionPage(client, { ref: String(internal.number), locale: 'ru' })).toBeNull();
  // Подбор номеров: клиент находит только опубликованные для клиентов.
  for (let n = draftOnly.number - 2; n <= internal.number + 2; n++) {
    const page = await clientSolutionPage(client, { ref: String(n), locale: 'ru' });
    expect(page, `номер ${n}`).toBeNull();
  }
  for (const ref of ['abc', '0', `${draftOnly.number}/../1`, '-1']) expect(await clientSolutionPage(client, { ref, locale: 'ru' })).toBeNull();
});

test('текст модели не доходит до клиента: черновик от AI после публикации виден только сотруднику', async () => {
  const d = await draft();
  const ctx = await l2();
  await publishSolution(ctx, publishInput(d));
  const published = await current(d.number);
  const modelText = doc(p('pwhat00001', 'Шаги от модели: позвоните на +998 90 000 00 00'), step('step000001', 'Шаг, написанный моделью'));
  const saved = await saveSolutionDraft(staffCtx(f.l1), {
    number: d.number,
    locale: 'ru',
    versionId: published.versionId,
    revision: published.revision,
    title: 'Заголовок от модели',
    doc: modelText,
  });
  if (saved.status !== 'saved') throw new Error('не сохранено');
  await pools.root.query(`update hdk_article_versions set is_machine = true where version_id = $1`, [saved.versionId]);
  const page = await clientSolutionPage(await clientCtx(f.aUser), { ref: String(d.number), locale: 'ru' });
  if (page?.kind !== 'solution') throw new Error('нет страницы');
  expect(page.solution.title).toBe('Остаток не списывается');
  expect(JSON.stringify(page.solution.doc)).not.toContain('модел');
  // Сотрудник видит черновик с пометкой.
  expect((await current(d.number)).state.current).toMatchObject({ state: 'draft', isMachine: true, title: 'Заголовок от модели' });
});

test('изображение клиенту: только файл из видимой копии этого решения; черновой, чужой и внутренний не отдаются', async () => {
  const d = await draft();
  const file = async (articleId: string, status = 'clean') => {
    const id = (
      await pools.root.query(
        `insert into hdk_article_files (article_id, storage_key, file_name, mime, size, scan_status) values ($1, 'pending', 'shot.png', 'image/png', $2, $3) returning file_id`,
        [articleId, PNG.byteLength, status],
      )
    ).rows[0].file_id as string;
    await pools.root.query(`update hdk_article_files set storage_key = $2 where file_id = $1`, [id, status === 'clean' ? `files/kb/${articleId}/${id}` : `quarantine/kb/${id}`]);
    if (status === 'clean') await storage.put(`files/kb/${articleId}/${id}`, PNG, 'image/png');
    return id;
  };
  const shown = await file(d.articleId);
  const draftFile = await file(d.articleId);
  const pending = await file(d.articleId, 'pending');
  const image = (id: string, fileId: string) => ({ type: 'image', attrs: { id, fileId, alt: null } });
  const ctx = await l2();
  // Непроверенный файл в документе: публикация не проходит.
  const withPending = doc(p('pwhat00001', 'Текст'), step('step000001', 'Откройте Склад', [image('image00001', shown), image('image00002', pending)]));
  const first = await saveSolutionDraft(staffCtx(f.l1), {
    number: d.number,
    locale: 'ru',
    versionId: d.versionId,
    revision: d.revision,
    title: 'С изображением',
    doc: withPending,
  });
  if (first.status !== 'saved') throw new Error('не сохранено');
  expect(first.review.filesNotClean).toEqual([pending]);
  expect(await publishSolution(ctx, { number: d.number, locale: 'ru', versionId: first.versionId, revision: first.revision, confirmFindings: true })).toMatchObject({
    status: 'not_ready',
    filesNotClean: [pending],
  });
  const withImage = doc(p('pwhat00001', 'Текст'), step('step000001', 'Откройте Склад', [image('image00001', shown)]));
  const saved = await saveSolutionDraft(staffCtx(f.l1), {
    number: d.number,
    locale: 'ru',
    versionId: first.versionId,
    revision: first.revision,
    title: 'С изображением',
    doc: withImage,
  });
  if (saved.status !== 'saved') throw new Error('не сохранено');
  expect((await publishSolution(ctx, { number: d.number, locale: 'ru', versionId: saved.versionId, revision: saved.revision, confirmFindings: false })).status).toBe('published');
  expect((await pools.root.query(`select file_ids from hdk_published where article_id = $1`, [d.articleId])).rows[0].file_ids).toEqual([shown]);

  const client = await clientCtx(f.bUser);
  const ok = await clientSolutionFileResponse(client, { ref: `${d.number}-s-izobrazheniem`, fileId: shown });
  expect(ok.status).toBe(200);
  expect(ok.headers.get('x-content-type-options')).toBe('nosniff');
  expect(ok.headers.get('content-type')).toBe('image/png');
  expect(ok.headers.get('content-disposition')).toMatch(/^inline;/);
  expect(new Uint8Array(await ok.arrayBuffer())).toEqual(PNG);
  // Файл черновика (загружен к статье, но не в копии), файл с номером другого решения, без входа.
  expect((await clientSolutionFileResponse(client, { ref: String(d.number), fileId: draftFile })).status).toBe(404);
  const second = await draft(READY, 'Другое решение');
  await publishSolution(ctx, publishInput(second));
  expect((await clientSolutionFileResponse(client, { ref: String(second.number), fileId: shown })).status).toBe(404);
  expect((await clientSolutionFileResponse(null, { ref: String(d.number), fileId: shown })).status).toBe(401);
  // Решение стало "только через сотрудника": файл клиенту больше не отдаётся.
  await saveSolutionMeta(staffCtx(f.l1), { number: d.number, moduleId, audience: 'internal' });
  expect((await clientSolutionFileResponse(client, { ref: String(d.number), fileId: shown })).status).toBe(404);
});

test('"Помогло" и "Не помогло": счётчик пишет система, один голос в сутки, исход сессии подсказки обновляется', async () => {
  const d = await draft();
  await publishSolution(await l2(), publishInput(d));
  const client = await clientCtx(f.aUser);
  const session = (
    await pools.root.query(
      `insert into hdk_deflection_events (org_id, session_id, user_id, query_hash, shown_article_ids) values ($1, uuidv7(), $2, repeat('c', 64), array[$3::uuid]) returning session_id`,
      [f.orgA.orgId, f.aUser.userId, d.articleId],
    )
  ).rows[0].session_id as string;
  expect(await recordSolutionFeedback(client, { number: d.number, outcome: 'helped', sessionId: session })).toEqual({ counted: true });
  expect(await recordSolutionFeedback(client, { number: d.number, outcome: 'helped' })).toEqual({ counted: false });
  expect((await pools.root.query(`select helped_count, not_helped_count from hdk_articles where article_id = $1`, [d.articleId])).rows[0]).toEqual({
    helped_count: 1,
    not_helped_count: 0,
  });
  expect((await pools.root.query(`select outcome from hdk_deflection_events where session_id = $1`, [session])).rows[0].outcome).toBe('helped');
  // Чужую сессию клиент не меняет.
  const other = await clientCtx(f.bUser);
  await recordSolutionFeedback(other, { number: d.number, outcome: 'not_helped', sessionId: session });
  expect((await pools.root.query(`select outcome from hdk_deflection_events where session_id = $1`, [session])).rows[0].outcome).toBe('helped');
  // Решение, которого клиент не видит.
  const hidden = await draft(READY, 'Черновик');
  await expect(recordSolutionFeedback(client, { number: hidden.number, outcome: 'helped' })).rejects.toMatchObject({ code: 'not_found' });
});

test('разрешённые домены: только администратор со свежим входом, адрес приводится к домену, мусор называется', async () => {
  const admin = staffCtx(f.adminStaff);
  expect(await allowedDomainsSetting(admin)).toEqual(['smartup.uz']);
  await expect(saveAllowedDomains(staffCtx(f.care), { text: 'smartup.uz' })).rejects.toMatchObject({ code: 'forbidden' });
  await expect(saveAllowedDomains({ ...admin, sessionCreatedAt: new Date(Date.now() - 3600_000) }, { text: 'smartup.uz' })).rejects.toMatchObject({ code: 'stale_session' });
  expect(await saveAllowedDomains(admin, { text: 'https://Docs.Smartup.uz/path, smartup.uz\nsmartup.uz' })).toEqual({ ok: true, domains: ['docs.smartup.uz', 'smartup.uz'] });
  expect(await readAllowedDomains()).toEqual(['docs.smartup.uz', 'smartup.uz']);
  expect(await saveAllowedDomains(admin, { text: 'smartup.uz 10.0.0.1' })).toEqual({ ok: false, invalid: '10.0.0.1' });
  expect(await readAllowedDomains()).toEqual(['docs.smartup.uz', 'smartup.uz']);
  expect((await pools.root.query(`select 1 from hdc_audit_log where action = 'settings.changed' and object_id = 'kb.allowed_domains'`)).rowCount).toBe(1);
});
