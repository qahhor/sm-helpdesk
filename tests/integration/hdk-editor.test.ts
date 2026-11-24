import { afterEach, beforeEach, expect, test } from 'vitest';
import { createDraftArticle } from '@/modules/hdk/api/articles';
import { listSolutions, restoreSolutionVersion, saveSolutionDraft, saveSolutionMeta, solutionEditorState } from '@/modules/hdk/api/editor';
import { completeSolutionFile, presignSolutionFile, scanSolutionFile, solutionFileStatus, staffSolutionFileResponse } from '@/modules/hdk/api/files';
import { MemoryJobQueue, MemoryStorage, setJobQueueForTests, setScannerForTests, setStorageForTests } from '@/modules/hdc/testing';
import { createStubScanner } from '@/modules/hdc/antivirus/stub';
import { staffCtx, staffWithRole } from './helpers/auth';
import { asActor, pools, system } from './helpers/db';
import { type Fixture, seedTwoOrgs } from './isolation/fixture';

// Редактор решения, версии и изображения (план M5, задача 3; UX-W-01..04, решение 16). Автосохранение с проверкой
// версии строки: второе сохранение из другой вкладки получает конфликт и ничего не затирает ("На что смотреть при
// проверке", пункт 7). Пишут agent_l1, agent_l2, care, admin; product только читает (решение 10).

let f: Fixture;
let storage: MemoryStorage;
let jobs: MemoryJobQueue;

const p = (id: string, text?: string) => ({ type: 'paragraph' as const, attrs: { id }, ...(text ? { content: [{ type: 'text' as const, text }] } : {}) });
const doc = (text: string, extra: object[] = []) => ({ version: 1 as const, blocks: [p('pbody00001', text), ...extra] });
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...new Array(56).fill(1)]);

beforeEach(async () => {
  f = await seedTwoOrgs();
  storage = new MemoryStorage();
  setStorageForTests(storage);
  setScannerForTests(createStubScanner());
  jobs = new MemoryJobQueue();
  setJobQueueForTests(jobs);
});
afterEach(() => {
  setStorageForTests(null);
  setScannerForTests(null);
  setJobQueueForTests(null);
});

async function newSolution(title = 'Остаток не списывается') {
  return createDraftArticle(staffCtx(f.l1), { locale: 'ru', title, audience: 'clients', doc: doc('Первый текст') });
}
async function editor(number: number, ctx = staffCtx(f.l1)) {
  const state = await solutionEditorState(ctx, { number });
  if (!state) throw new Error('нет решения');
  return state;
}

test('автосохранение: версия строки сменилась, второе сохранение из другой вкладки получает конфликт и ничего не затирает', async () => {
  const { number } = await newSolution();
  const first = await editor(number);
  const second = await editor(number);
  const saved = await saveSolutionDraft(staffCtx(f.l1), {
    number,
    locale: 'ru',
    versionId: first.current.versionId,
    revision: first.current.revision,
    title: 'Вкладка 1',
    doc: doc('Текст первой вкладки'),
  });
  expect(saved.status).toBe('saved');
  // Вторая вкладка правит от прежней версии строки.
  const stale = await saveSolutionDraft(staffCtx(f.l1), {
    number,
    locale: 'ru',
    versionId: second.current.versionId,
    revision: second.current.revision,
    title: 'Вкладка 2',
    doc: doc('Текст второй вкладки'),
  });
  expect(stale).toEqual({ status: 'conflict' });
  const after = await editor(number);
  expect(after.current.title).toBe('Вкладка 1');
  expect(JSON.stringify(after.current.doc)).toContain('Текст первой вкладки');
  // Первая вкладка продолжает со своей новой меткой.
  if (saved.status !== 'saved') throw new Error('не сохранено');
  const next = await saveSolutionDraft(staffCtx(f.l1), {
    number,
    locale: 'ru',
    versionId: saved.versionId,
    revision: saved.revision,
    title: 'Вкладка 1, правка',
    doc: doc('Ещё правка'),
  });
  expect(next.status).toBe('saved');
  // Черновик один, история не выросла от автосохранений.
  expect((await editor(number)).versions).toHaveLength(1);
});

test('product и клиент не пишут черновик: отказ в коде и в базе', async () => {
  const { number, versionId } = await newSolution();
  const state = await editor(number);
  const product = staffCtx(await staffWithRole('product'));
  await expect(
    saveSolutionDraft(product, { number, locale: 'ru', versionId: state.current.versionId, revision: state.current.revision, title: 'x', doc: doc('x') }),
  ).rejects.toMatchObject({ code: 'forbidden' });
  await expect(createDraftArticle(product, { locale: 'ru', title: 'x', audience: 'clients', doc: doc('x') })).rejects.toMatchObject({ code: 'forbidden' });
  await expect(saveSolutionMeta(product, { number, moduleId: null, audience: 'internal' })).rejects.toMatchObject({ code: 'forbidden' });
  // product видит редактор только для чтения.
  expect((await editor(number, product)).canWrite).toBe(false);
  // Политика базы: строку черновика не обновляют ни product, ни клиент.
  for (const actor of [product.actor, f.aUser.actor]) {
    const updated = await asActor(pools.app, actor, (c) => c.query(`update hdk_article_versions set title = 'взлом' where version_id = $1`, [versionId]));
    expect(updated.rowCount).toBe(0);
  }
});

test('правка опубликованного решения создаёт новый черновик; второй черновик от той же основы получает конфликт', async () => {
  const { number, versionId, articleId } = await newSolution();
  // Публикация появится в задаче 4: здесь версия становится опубликованной под системой.
  await pools.root.query(`update hdk_article_versions set state = 'published' where version_id = $1`, [versionId]);
  const state = await editor(number);
  expect(state.current.state).toBe('published');
  const saved = await saveSolutionDraft(staffCtx(f.l1), { number, locale: 'ru', versionId, revision: state.current.revision, title: 'Правка', doc: doc('Новый текст') });
  expect(saved.status).toBe('saved');
  const again = await saveSolutionDraft(staffCtx(f.care), { number, locale: 'ru', versionId, revision: state.current.revision, title: 'Чужая правка', doc: doc('Другой текст') });
  expect(again).toEqual({ status: 'conflict' });
  const after = await editor(number);
  expect(after.current.state).toBe('draft');
  expect(after.current.number).toBe(2);
  expect(after.versions.map((v) => v.state)).toEqual(['draft', 'published']);
  const draftRef = await pools.root.query(`select draft_version_id from hdk_article_translations where article_id = $1 and locale = 'ru'`, [articleId]);
  expect(draftRef.rows[0].draft_version_id).toBe(after.current.versionId);
});

test('возврат к прежней версии: текст становится черновиком, история не меняется, запись в журнале', async () => {
  const { number, versionId, articleId } = await newSolution('Версия 1');
  // Переходы только draft -> published -> superseded (триггер версий).
  await pools.root.query(`update hdk_article_versions set state = 'published' where version_id = $1`, [versionId]);
  await pools.root.query(`update hdk_article_versions set state = 'superseded' where version_id = $1`, [versionId]);
  await pools.root.query(`insert into hdk_article_versions (article_id, locale, number, title, doc, state) values ($1, 'ru', 2, 'Версия 2', $2, 'published')`, [
    articleId,
    doc('Текст 2'),
  ]);
  await restoreSolutionVersion(staffCtx(f.l1), { number, locale: 'ru', versionId });
  const after = await editor(number);
  expect(after.current).toMatchObject({ state: 'draft', number: 3, title: 'Версия 1' });
  expect(JSON.stringify(after.current.doc)).toContain('Первый текст');
  expect(after.versions.map((v) => [v.number, v.state])).toEqual([
    [3, 'draft'],
    [2, 'published'],
    [1, 'superseded'],
  ]);
  const audit = await pools.root.query(`select diff from hdc_audit_log where action = 'solution.version_restored' and object_id = $1`, [articleId]);
  expect(audit.rows[0].diff).toMatchObject({ number, from: 1 });
  // Черновик возвращать нельзя: это не история.
  await expect(restoreSolutionVersion(staffCtx(f.l1), { number, locale: 'ru', versionId: after.current.versionId })).rejects.toMatchObject({ code: 'not_found' });
});

test('документ проходит закрытую схему, а изображение только из файлов этой статьи', async () => {
  const { number } = await newSolution();
  const other = await newSolution('Другое решение');
  const otherFile = (
    await pools.root.query(
      `insert into hdk_article_files (article_id, storage_key, file_name, mime, size, scan_status) values ($1, 'files/kb/x/y', 'a.png', 'image/png', 10, 'clean') returning file_id`,
      [other.articleId],
    )
  ).rows[0].file_id as string;
  const state = await editor(number);
  const base = { number, locale: 'ru', versionId: state.current.versionId, revision: state.current.revision, title: 'x' };
  const withImage = doc('Шаг', [
    { type: 'step', attrs: { id: 'stepimg001' }, content: [p('pstepimg01', 'Откройте'), { type: 'image', attrs: { id: 'imgforeign', fileId: otherFile, alt: null } }] },
  ]);
  await expect(saveSolutionDraft(staffCtx(f.l1), { ...base, doc: withImage })).rejects.toMatchObject({ code: 'invalid_input' });
  const script = { version: 1, blocks: [{ type: 'html', attrs: { id: 'scriptblk1' }, content: '<script>alert(1)</script>' }] };
  await expect(saveSolutionDraft(staffCtx(f.l1), { ...base, doc: script })).rejects.toMatchObject({ code: 'invalid_input' });
});

test('аудитория: первая линия сужает до "только через сотрудника" с записью в журнале, открыть опубликованное клиентам не может', async () => {
  const { number, articleId, versionId } = await newSolution();
  await saveSolutionMeta(staffCtx(f.l1), { number, moduleId: null, audience: 'internal' });
  const audit = await pools.root.query(`select diff from hdc_audit_log where action = 'solution.audience_changed' and object_id = $1`, [articleId]);
  expect(audit.rows[0].diff).toMatchObject({ from: 'clients', to: 'internal' });
  // Пока решение не опубликовано, вернуть может и первая линия.
  await saveSolutionMeta(staffCtx(f.l1), { number, moduleId: null, audience: 'clients' });
  await saveSolutionMeta(staffCtx(f.l1), { number, moduleId: null, audience: 'internal' });
  await pools.root.query(`update hdk_article_versions set state = 'published' where version_id = $1`, [versionId]);
  await pools.root.query(
    `insert into hdk_published (article_id, article_number, locale, version_id, audience, title, doc, body_text, slug, original_locale) values ($1, $2, 'ru', $3, 'internal', 't', $4, 't', 't', 'ru')`,
    [articleId, number, versionId, doc('t')],
  );
  await expect(saveSolutionMeta(staffCtx(f.l1), { number, moduleId: null, audience: 'clients' })).rejects.toMatchObject({ code: 'forbidden' });
  const l2 = staffCtx(await staffWithRole('agent_l2'));
  await saveSolutionMeta(l2, { number, moduleId: null, audience: 'clients' });
  expect((await editor(number)).audience).toBe('clients');
});

test('список: фильтры по статусу и языку, "Мои задачи" показывают мои черновики и решения на пересмотр', async () => {
  const mine = await newSolution('Мой черновик');
  const care = await createDraftArticle(staffCtx(f.care), { locale: 'uz', title: 'Qoldiq', audience: 'clients', doc: doc('Matn') });
  const ownReview = await newSolution('Часто не помогает');
  // Опубликованное без черновика, 12 исходов, 6 "не помогло" (50%): на пересмотр (решение 18).
  await pools.root.query(`update hdk_article_versions set state = 'published' where version_id = $1`, [ownReview.versionId]);
  await pools.root.query(`update hdk_article_translations set draft_version_id = null where article_id = $1`, [ownReview.articleId]);
  await pools.root.query(`update hdk_articles set helped_count = 6, not_helped_count = 6 where article_id = $1`, [ownReview.articleId]);
  const l1 = staffCtx(f.l1);
  const numbers = async (input: object) => (await listSolutions(l1, input)).map((row) => row.number).sort();
  expect(await numbers({ mine: true })).toEqual([mine.number, ownReview.number].sort());
  expect(await numbers({ status: 'published' })).toEqual([ownReview.number]);
  expect(await numbers({ status: 'draft' })).toEqual([mine.number, care.number].sort());
  expect(await numbers({ locale: 'uz' })).toEqual([care.number]);
  const review = (await listSolutions(l1, { mine: true })).find((row) => row.number === ownReview.number);
  expect(review).toMatchObject({ status: 'published', needsReview: true, hasDraft: false });
  await expect(listSolutions(l1, { status: 'nonsense' })).rejects.toMatchObject({ code: 'invalid_input' });
});

test('изображение: ссылка на загрузку, проверка антивирусом, перенос из карантина и выдача сотруднику с запретом угадывать тип', async () => {
  const { number, articleId } = await newSolution();
  const l1 = staffCtx(f.l1);
  await expect(presignSolutionFile(l1, { number, fileName: 'a.svg', mime: 'image/svg+xml', size: 10 })).rejects.toMatchObject({ code: 'invalid_input' });
  await expect(presignSolutionFile(l1, { number, fileName: 'big.png', mime: 'image/png', size: 11 * 1024 * 1024 })).rejects.toMatchObject({ code: 'file_too_large' });
  const { fileId } = await presignSolutionFile(l1, { number, fileName: 'shot.png', mime: 'image/png', size: PNG.byteLength });
  expect(storage.presigned.at(-1)).toMatchObject({ key: `quarantine/kb/${fileId}`, mime: 'image/png' });
  await storage.put(`quarantine/kb/${fileId}`, PNG, 'image/png');
  // Пока файл не проверен, сотрудник его не получает.
  expect((await staffSolutionFileResponse(l1, { number: String(number), fileId })).status).toBe(404);
  expect(await completeSolutionFile(l1, { fileId })).toEqual({ status: 'pending' });
  expect(jobs.sent).toContainEqual({ name: 'kb.scan', data: { fileId } });
  expect(await scanSolutionFile(system, fileId)).toBe('clean');
  expect(await solutionFileStatus(l1, { fileId })).toEqual({ status: 'clean' });
  expect(await storage.head(`quarantine/kb/${fileId}`)).toBeNull();
  expect(await storage.head(`files/kb/${articleId}/${fileId}`)).toEqual({ size: PNG.byteLength });
  const response = await staffSolutionFileResponse(staffCtx(await staffWithRole('product')), { number: String(number), fileId });
  expect(response.status).toBe(200);
  expect(response.headers.get('content-type')).toBe('image/png');
  expect(response.headers.get('x-content-type-options')).toBe('nosniff');
  expect(response.headers.get('content-disposition')).toMatch(/^inline;/);
  expect(new Uint8Array(await response.arrayBuffer())).toEqual(PNG);
  // Файл чужого решения по номеру другого решения не отдаётся; без входа 401.
  const other = await newSolution('Другое');
  expect((await staffSolutionFileResponse(l1, { number: String(other.number), fileId })).status).toBe(404);
  expect((await staffSolutionFileResponse(null, { number: String(number), fileId })).status).toBe(401);
});

test('изображение: не тот тип по содержимому отклоняется, заражённое пишется в журнал', async () => {
  const { number } = await newSolution();
  const l1 = staffCtx(f.l1);
  const html = new TextEncoder().encode('<html><script>alert(1)</script></html>');
  const fake = await presignSolutionFile(l1, { number, fileName: 'x.png', mime: 'image/png', size: html.byteLength });
  await storage.put(`quarantine/kb/${fake.fileId}`, html, 'image/png');
  expect(await scanSolutionFile(system, fake.fileId)).toBe('rejected');
  const eicar = new Uint8Array([...PNG, ...new TextEncoder().encode(['EICAR', 'STANDARD', 'ANTIVIRUS', 'TEST', 'FILE'].join('-'))]);
  const bad = await presignSolutionFile(l1, { number, fileName: 'v.png', mime: 'image/png', size: eicar.byteLength });
  await storage.put(`quarantine/kb/${bad.fileId}`, eicar, 'image/png');
  expect(await scanSolutionFile(system, bad.fileId)).toBe('infected');
  const audit = await pools.root.query(`select 1 from hdc_audit_log where action = 'solution.file_infected' and object_id = $1`, [bad.fileId]);
  expect(audit.rowCount).toBe(1);
  expect(await storage.head(`quarantine/kb/${bad.fileId}`)).toBeNull();
});
