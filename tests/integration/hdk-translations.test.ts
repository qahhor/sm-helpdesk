import { afterEach, beforeEach, expect, test } from 'vitest';
import type { SystemActor } from '@/db/with-actor';
import { setAiClientForTests, StubAiClient, type StubCall } from '@/modules/hda/testing';
import { MemoryJobQueue, setJobQueueForTests } from '@/modules/hdc/testing';
import { runTranslationJob } from '@/modules/hdk/api/ai-jobs';
import { createDraftArticle } from '@/modules/hdk/api/articles';
import { clientSolutionPage } from '@/modules/hdk/api/client';
import { saveSolutionDraft, solutionEditorState } from '@/modules/hdk/api/editor';
import { markSolutionTextRead, publishSolution } from '@/modules/hdk/api/publish';
import { requestMachineTranslation, startManualTranslation } from '@/modules/hdk/api/translations';
import { defaultStubResponse } from '@/modules/hda/testing';
import { clientCtx, staffCtx, staffWithRole } from './helpers/auth';
import { pools } from './helpers/db';
import { type Fixture, seedTwoOrgs } from './isolation/fixture';

// Переводы решения (план M5, задача 6; FR-SOL-06, 18, UX-W-06, FR-I18N-07, решение 9, поправка 101). "На что смотреть
// при проверке", пункт 2: машинный перевод с дописанной ссылкой или телефоном и перевод с другим числом шагов не
// доходят до клиента; машинный перевод доходит только публикацией сотрудника и с пометкой.

const SYSTEM: SystemActor = { type: 'system', job: 'kb.translate' };
let f: Fixture;
let jobs: MemoryJobQueue;
let stub: StubAiClient;
let moduleId: string;

const p = (id: string, text: string, marks?: object[]) => ({ type: 'paragraph' as const, attrs: { id }, content: [{ type: 'text' as const, text, ...(marks ? { marks } : {}) }] });
const step = (id: string, text: string) => ({ type: 'step' as const, attrs: { id }, content: [p(`${id}p`, text)] });
const doc = (...blocks: object[]) => ({ version: 1 as const, blocks });
const ORIGINAL = doc(
  p('pwhat00001', 'Отчёт за 2026 год не строится, смотрите', [{ type: 'link', attrs: { href: 'https://docs.smartup.uz/reports' } }]),
  step('step000001', 'Откройте раздел «Склад»'),
  step('step000002', 'Нажмите «Провести»'),
);

beforeEach(async () => {
  f = await seedTwoOrgs();
  jobs = new MemoryJobQueue();
  setJobQueueForTests(jobs);
  stub = new StubAiClient();
  setAiClientForTests(stub);
  moduleId = (await pools.root.query(`insert into hdr_product_modules (code, name) values ('tr-${Date.now()}-${Math.random()}', '{"ru": "Склад"}') returning module_id`)).rows[0].module_id as string;
  await pools.root.query(`delete from hdc_settings where code in ('kb.allowed_domains', 'ai.daily_limit')`);
  await pools.root.query(`insert into hdc_settings (code, value) values ('kb.allowed_domains', '["smartup.uz"]')`);
});
afterEach(() => {
  setJobQueueForTests(null);
  setAiClientForTests();
});

const l2 = () => staffWithRole('agent_l2').then(staffCtx);

async function state(number: number, locale: 'ru' | 'uz' | 'en') {
  const s = await solutionEditorState(staffCtx(f.l1), { number, locale });
  if (!s) throw new Error('нет языка');
  return s;
}

/** Опубликованное русское решение. */
async function published() {
  const created = await createDraftArticle(staffCtx(f.l1), { locale: 'ru', title: 'Отчёт не строится', audience: 'clients', moduleId, doc: ORIGINAL });
  const s = await state(created.number, 'ru');
  expect((await publishSolution(await l2(), { number: created.number, locale: 'ru', versionId: s.current.versionId, revision: s.current.revision, confirmFindings: false })).status).toBe('published');
  return created;
}

/** Машинный перевод на узбекский: задача поставлена, фоновый процесс её выполнил. */
async function machine(number: number, articleId: string, respond?: (call: StubCall) => unknown) {
  stub.respond = respond ?? null;
  expect(await requestMachineTranslation(staffCtx(f.l1), { number, locale: 'uz' })).toBe('started');
  expect(jobs.sent.at(-1)).toEqual({ name: 'kb.translate', data: { articleId, locale: 'uz' } });
  await runTranslationJob(SYSTEM, { articleId, locale: 'uz' });
  return state(number, 'uz');
}

/** Ответ заглушки: те же куски с подменой одного. */
const replacing = (id: string, text: string) => (call: StubCall) => {
  const out = defaultStubResponse(call) as { segments: { id: string; text: string }[] };
  return { segments: out.segments.map((s) => (s.id === id ? { id, text } : { id: s.id, text: `UZ ${s.text}` })) };
};

const publishUz = async (s: Awaited<ReturnType<typeof state>>, confirmFindings = false) =>
  publishSolution(await l2(), { number: s.number, locale: 'uz', versionId: s.current.versionId, revision: s.current.revision, confirmFindings });

test('машинный перевод: задача, черновик с пометкой и версией оригинала, адрес ссылки в модель не уходит, публикация с пометкой для клиента', async () => {
  const a = await published();
  const s = await machine(a.number, a.articleId, replacing('title', 'Hisobot tuzilmaydi'));
  expect(s.current).toMatchObject({ state: 'draft', isMachine: true, title: 'Hisobot tuzilmaydi' });
  expect(JSON.stringify(s.current.doc)).toContain('UZ Откройте раздел «Склад»');
  expect(JSON.stringify(s.current.doc)).toContain('https://docs.smartup.uz/reports');
  expect(s.review.invariants).toEqual([]);
  expect(s.review.readiness.ready).toBe(true);
  expect(s.languages.find((l) => l.locale === 'uz')).toMatchObject({ aiStatus: 'ready', draft: true, published: false });
  // В модель ушёл только текст решения: без адреса ссылки.
  expect(stub.calls).toHaveLength(1);
  expect(stub.calls[0]!.data).not.toContain('docs.smartup.uz');
  expect(stub.calls[0]!.data).toContain('<solution>');
  // До публикации клиент на узбекском видит русский оригинал с пометкой "пока не переведено".
  const client = await clientCtx(f.aUser);
  const before = await clientSolutionPage(client, { ref: String(a.number), locale: 'uz' });
  expect(before).toMatchObject({ kind: 'solution', notTranslated: true, solution: { locale: 'ru' } });

  expect(await publishUz(s)).toMatchObject({ status: 'published' });
  const copy = (await pools.root.query(`select is_machine, is_outdated, original_locale, title from hdk_published where article_id = $1 and locale = 'uz'`, [a.articleId])).rows[0];
  expect(copy).toEqual({ is_machine: true, is_outdated: false, original_locale: 'ru', title: 'Hisobot tuzilmaydi' });
  expect((await pools.root.query(`select status from hdk_article_translations where article_id = $1 and locale = 'uz'`, [a.articleId])).rows[0].status).toBe('machine');
  const after = await clientSolutionPage(client, { ref: String(a.number), locale: 'uz' });
  expect(after).toMatchObject({ kind: 'solution', notTranslated: false, solution: { locale: 'uz', isMachine: true } });
  expect(jobs.sent.at(-1)).toEqual({ name: 'kb.index', data: { articleId: a.articleId } });
});

test('пункт 2: машинный перевод с дописанной ссылкой не публикуется даже с подтверждением находок', async () => {
  const a = await published();
  const s = await machine(a.number, a.articleId, replacing('step000002p.0', 'Bosing https://evil.example/login «Provesti»'));
  expect(s.review.invariants.map((i) => i.kind)).toEqual(['links']);
  expect(s.review.findings).toContainEqual(expect.objectContaining({ kind: 'link', text: 'evil.example', blocking: true }));
  expect(await publishUz(s, true)).toMatchObject({ status: 'not_ready', readiness: { ready: false } });
  expect((await pools.root.query(`select 1 from hdk_published where article_id = $1 and locale = 'uz'`, [a.articleId])).rowCount).toBe(0);
});

test('пункт 2: машинный перевод с телефоном не публикуется, пока сотрудник не подтвердит перевод; затем только с подтверждением находки', async () => {
  const a = await published();
  const s = await machine(a.number, a.articleId, replacing('step000001p.0', 'Qo‘ng‘iroq qiling +998 90 123 45 67 «Ombor»'));
  expect(s.review.invariants.map((i) => i.kind)).toEqual(['numbers']);
  expect(s.review.findings.map((x) => x.kind)).toContain('phone');
  expect(await publishUz(s, true)).toMatchObject({ status: 'not_ready', readiness: { items: { textRead: false } } });
  // Сотрудник прочитал и подтвердил перевод: расхождение остаётся видно, но решает человек; находка требует подтверждения.
  const read = await markSolutionTextRead(staffCtx(f.l1), { number: a.number, locale: 'uz', versionId: s.current.versionId, revision: s.current.revision });
  expect(read.status).toBe('read');
  const confirmed = await state(a.number, 'uz');
  expect(await publishUz(confirmed)).toMatchObject({ status: 'not_ready', readiness: { needsConfirm: true } });
  expect(await publishUz(confirmed, true)).toMatchObject({ status: 'published' });
  const copy = (await pools.root.query(`select is_machine from hdk_published where article_id = $1 and locale = 'uz'`, [a.articleId])).rows[0];
  expect(copy.is_machine).toBe(false);
  expect((await pools.root.query(`select status from hdk_article_translations where article_id = $1 and locale = 'uz'`, [a.articleId])).rows[0].status).toBe('reviewed');
});

test('пункт 2: машинный перевод с другим числом шагов не публикуется', async () => {
  const a = await published();
  const s = await machine(a.number, a.articleId);
  // Шаг пропал из машинного текста (правка, которую сотрудник не подтверждал).
  const fewer = { ...s.current.doc, blocks: s.current.doc.blocks.slice(0, 2) };
  const saved = await saveSolutionDraft(staffCtx(f.l1), { number: a.number, locale: 'uz', versionId: s.current.versionId, revision: s.current.revision, title: s.current.title, doc: fewer });
  expect(saved.status).toBe('saved');
  if (saved.status !== 'saved') return;
  expect(saved.review.invariants.map((i) => i.kind)).toEqual(['quotes', 'steps']);
  expect(await publishSolution(await l2(), { number: a.number, locale: 'uz', versionId: saved.versionId, revision: saved.revision, confirmFindings: true })).toMatchObject({ status: 'not_ready' });
});

test('изменение оригинала делает перевод устаревшим, клиент видит пометку; изменившиеся блоки подсвечены', async () => {
  const a = await published();
  const s = await machine(a.number, a.articleId);
  await publishUz(s);
  const ru = await state(a.number, 'ru');
  const changed = { ...ORIGINAL, blocks: [ORIGINAL.blocks[0], step('step000001', 'Откройте раздел «Склад» и выберите период'), ORIGINAL.blocks[2]] };
  const saved = await saveSolutionDraft(staffCtx(f.l1), { number: a.number, locale: 'ru', versionId: ru.current.versionId, revision: ru.current.revision, title: ru.current.title, doc: changed });
  if (saved.status !== 'saved') throw new Error('не сохранено');
  expect((await publishSolution(await l2(), { number: a.number, locale: 'ru', versionId: saved.versionId, revision: saved.revision, confirmFindings: false })).status).toBe('published');
  expect((await pools.root.query(`select status from hdk_article_translations where article_id = $1 and locale = 'uz'`, [a.articleId])).rows[0].status).toBe('outdated');
  const client = await clientCtx(f.bUser);
  expect(await clientSolutionPage(client, { ref: String(a.number), locale: 'uz' })).toMatchObject({ solution: { locale: 'uz', isOutdated: true } });
  const uz = await state(a.number, 'uz');
  expect(uz.original?.changedBlockIds).toEqual(['step000001']);
});

test('перевести самому: черновик копией оригинала; без опубликованного оригинала перевод не начинается; product не переводит', async () => {
  const draftOnly = await createDraftArticle(staffCtx(f.l1), { locale: 'ru', title: 'Черновик', audience: 'clients', moduleId, doc: ORIGINAL });
  expect(await requestMachineTranslation(staffCtx(f.l1), { number: draftOnly.number, locale: 'en' })).toBe('no_original');
  expect(jobs.sent).toHaveLength(0);
  await expect(requestMachineTranslation(staffCtx(f.l1), { number: draftOnly.number, locale: 'ru' })).rejects.toMatchObject({ code: 'invalid_input' });
  await expect(startManualTranslation(staffCtx(await staffWithRole('product')), { number: draftOnly.number, locale: 'en' })).rejects.toMatchObject({ code: 'forbidden' });
  const a = await published();
  expect(await startManualTranslation(staffCtx(f.l1), { number: a.number, locale: 'en' })).toBe('started');
  const en = await state(a.number, 'en');
  expect(en.current).toMatchObject({ state: 'draft', isMachine: false, title: 'Отчёт не строится' });
  expect(en.original?.changedBlockIds).toEqual([]);
  expect(await startManualTranslation(staffCtx(f.l1), { number: a.number, locale: 'en' })).toBe('exists');
});

test('сбой модели и суточный предел отмечаются на странице; повтор после готового перевода ничего не меняет', async () => {
  const a = await published();
  stub.respond = () => new Error('нет сети');
  await requestMachineTranslation(staffCtx(f.l1), { number: a.number, locale: 'en' });
  await expect(runTranslationJob(SYSTEM, { articleId: a.articleId, locale: 'en' })).rejects.toThrow();
  expect((await state(a.number, 'ru')).languages.find((l) => l.locale === 'en')?.aiStatus).toBe('failed');
  await pools.root.query(`insert into hdc_settings (code, value) values ('ai.daily_limit', '0')`);
  await requestMachineTranslation(staffCtx(f.l1), { number: a.number, locale: 'en' });
  await runTranslationJob(SYSTEM, { articleId: a.articleId, locale: 'en' });
  expect((await state(a.number, 'ru')).languages.find((l) => l.locale === 'en')?.aiStatus).toBe('limited');
  // Задача без ожидающего языка (повтор, устаревшая) модель не вызывает.
  const calls = stub.calls.length;
  await runTranslationJob(SYSTEM, { articleId: a.articleId, locale: 'en' });
  expect(stub.calls.length).toBe(calls);
});
