import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, expect, test } from 'vitest';
import type { SystemActor } from '@/db/with-actor';
import { setLogSinkForTests } from '@/lib/log';
import { MemoryJobQueue, setJobQueueForTests } from '@/modules/hdc/testing';
import { createDraftArticle } from '@/modules/hdk/api/articles';
import { recordSolutionFeedback } from '@/modules/hdk/api/client';
import { solutionEditorState } from '@/modules/hdk/api/editor';
import { archiveSolution, publishSolution } from '@/modules/hdk/api/publish';
import { runIndexJob } from '@/modules/hdk/api/search-jobs';
import { recordSuggestNotHelped, recordSuggestTicket, relatedSolutions, searchSolutions, suggestForClient } from '@/modules/hdk/api/suggest';
import { type EmbeddingProvider, EmbeddingUnavailableError, setEmbedderForTests } from '@/modules/hdk/embeddings';
import { createStubEmbedder } from '@/modules/hdk/embeddings/stub';
import { clientCtx, ensureOrg, staffCtx, staffWithRole } from './helpers/auth';
import { captureQueries } from './helpers/bulk';
import { asActor, pools } from './helpers/db';
import { type Fixture, seedTwoOrgs } from './isolation/fixture';

// Гибридный поиск, подсказка и исходы (план M5, задача 10; ТЗ 11.6, FR-SOL-08..14, FR-AG-05; решения 5, 8, 12, 13, 17).
// "На что смотреть при проверке", пункт 5: подсказка не находит текст чужого и своего обращения, исходы и организации
// сигнатур клиенту недоступны, число организаций без названий и только от трёх, запрос подсказки не трогает обращения
// (время ответа от них не зависит). Пункт 6: отказ сервиса векторов не ломает подсказку. Клиент никогда не получает
// внутреннее, архивное решение и черновик.

const SYSTEM: SystemActor = { type: 'system', job: 'kb.index' };
let f: Fixture;
let moduleId: string;
let serial = 0;
const newId = () => `sug${String(++serial).padStart(9, '0')}`;
const p = (text: string) => ({ type: 'paragraph' as const, attrs: { id: newId() }, content: [{ type: 'text' as const, text }] });
const step = (text: string) => ({ type: 'step' as const, attrs: { id: newId() }, content: [p(text)] });
const doc = (what: string, todo: string) => ({ version: 1 as const, blocks: [p(what), step(todo)] });

beforeEach(async () => {
  f = await seedTwoOrgs();
  setJobQueueForTests(new MemoryJobQueue());
  setEmbedderForTests(createStubEmbedder());
  moduleId = (await pools.root.query(`insert into hdr_product_modules (code, name) values ('sug-${Date.now()}-${Math.random()}', '{"ru": "Заказы"}') returning module_id`)).rows[0].module_id as string;
  await pools.root.query(`delete from hdk_search_documents`);
  await pools.root.query(`delete from hdc_rate_limits where code like 'kb-%'`);
  await pools.root.query(`delete from hdc_settings where code = 'kb.allowed_domains'`);
  await pools.root.query(`insert into hdc_settings (code, value) values ('kb.allowed_domains', '["smartup.uz"]')`);
});
afterEach(() => {
  setJobQueueForTests(null);
  setEmbedderForTests(null);
  setLogSinkForTests(null);
});

async function solution(title: string, what: string, todo: string, opts: { audience?: 'clients' | 'internal'; publish?: boolean; index?: boolean } = {}) {
  const created = await createDraftArticle(staffCtx(f.l1), { locale: 'ru', title, audience: opts.audience ?? 'clients', moduleId, doc: doc(what, todo) });
  const l2 = staffCtx(await staffWithRole('agent_l2'));
  if (opts.publish !== false) {
    const state = await solutionEditorState(staffCtx(f.l1), { number: created.number });
    const outcome = await publishSolution(l2, { number: created.number, locale: 'ru', versionId: state!.current.versionId, revision: state!.current.revision, confirmFindings: false });
    expect(outcome.status).toBe('published');
    if (opts.index !== false) await runIndexJob(SYSTEM, { articleId: created.articleId });
  }
  return { ...created, l2 };
}

const ORDER_STOCK = () => solution('Заказ не сохраняется: нет остатка на складе', 'При сохранении заказа выходит ошибка о нехватке остатка на складе', 'Откройте Склад и проверьте остаток товара');
const ask = async (text: string, sessionId: string = randomUUID(), member = f.aUser) => suggestForClient(await clientCtx(member), { text, sessionId, locale: 'ru' });

test('клиент находит опубликованное решение по словам описания, с номером и адресом', async () => {
  const s = await ORDER_STOCK();
  await solution('Как поменять пароль', 'Пароль входа нужно сменить', 'Откройте профиль');
  const result = await ask('при сохранении заказа ошибка: нет остатка на складе');
  expect(result.limited).toBe(false);
  expect(result.items).toEqual([{ number: s.number, slug: 'zakaz-ne-sokhranyaetsya-net-ostatka-na-sklade', title: 'Заказ не сохраняется: нет остатка на складе', exact: false, orgCount: null }]);
  // Короткий запрос не ищется и предел не расходует.
  expect((await ask('за')).items).toEqual([]);
  // Одно слово не описание проблемы: подсказка не показывается (FR-SOL-09).
  expect((await ask('склад')).items).toEqual([]);
});

test('клиенту никогда не попадают внутреннее, архивное решение и черновик, даже по точным словам', async () => {
  await solution('Сброс очереди обмена с кассой', 'Очередь обмена с кассой зависла', 'Перезапустите службу обмена кассы', { audience: 'internal' });
  const archived = await solution('Печать накладной обрезана справа', 'Накладная печатается обрезанной справа', 'Выберите формат бумаги A4');
  await archiveSolution(archived.l2, { number: archived.number });
  await solution('Отчёт по продажам пустой за месяц', 'Отчёт по продажам пустой за выбранный месяц', 'Проверьте период отчёта', { publish: false });
  expect((await ask('очередь обмена с кассой зависла')).items).toEqual([]);
  expect((await ask('накладная печатается обрезанной справа')).items).toEqual([]);
  expect((await ask('отчёт по продажам пустой за месяц')).items).toEqual([]);
  // Сотрудник внутреннее решение находит (FR-AG-05), архивное и черновик нет.
  const staff = await searchSolutions(f.l1.actor, { text: 'очередь обмена с кассой зависла', signature: null, moduleId: null, locale: 'ru', audiences: ['internal', 'clients'] });
  expect(staff.items.map((i) => i.title)).toEqual(['Сброс очереди обмена с кассой']);
  expect((await searchSolutions(f.l1.actor, { text: 'накладная печатается обрезанной справа', signature: null, moduleId: null, locale: 'ru', audiences: ['internal', 'clients'] })).items).toEqual([]);
});

test('пункт 5: текст своего и чужого обращения подсказка не находит, запрос подсказки не читает обращения', async () => {
  await ORDER_STOCK();
  const words = 'Квазиморфный шпиндель Зюзякина не вращается';
  await pools.root.query(`update hdt_tickets set title = $2, description = $2 where ticket_id = any($1::uuid[])`, [[f.tickets.aOrg.ticketId, f.tickets.bOrg.ticketId], words]);
  const ctx = await clientCtx(f.aUser);
  const { result, queries } = await captureQueries(() => suggestForClient(ctx, { text: words, sessionId: randomUUID(), locale: 'ru' }));
  expect(result.items).toEqual([]);
  expect(queries.some((q) => /hdt_tickets|hdt_ticket_messages/.test(q.text))).toBe(false);
  // Клиент не читает исходы подсказки, сигнатуры и организации сигнатур.
  for (const table of ['hdk_deflection_events', 'hdk_signature_orgs', 'hdk_error_signatures'])
    expect(await asActor(pools.app, ctx.actor, async (c) => (await c.query(`select 1 from ${table}`)).rowCount), table).toBe(0);
});

test('сигнатура: пустая таблица не мешает; точное совпадение первым; число организаций только от трёх и без названий', async () => {
  const s = await ORDER_STOCK();
  const sig = 'a'.repeat(31) + 'b';
  const none = await searchSolutions((await clientCtx(f.aUser)).actor, { text: 'совсем другое описание проблемы', signature: sig, moduleId: null, locale: 'ru', audiences: ['clients'] });
  expect(none.items).toEqual([]);
  await pools.root.query(`delete from hdk_error_signatures where signature = $1`, [sig]);
  await pools.root.query(`insert into hdk_error_signatures (signature, article_id, sample_code) values ($1, $2, 'ORA-20001')`, [sig, s.articleId]);
  const search = async (member: { userId: string }) =>
    (await searchSolutions((await clientCtx(member)).actor, { text: 'совсем другое описание проблемы', signature: sig, moduleId: null, locale: 'ru', audiences: ['clients'] })).items;
  const first = await search(f.aUser);
  expect(first.map((i) => [i.number, i.exact, i.orgCount])).toEqual([[s.number, true, null]]);
  expect(await search(f.bUser)).toMatchObject([{ exact: true, orgCount: null }]);
  // Третья организация: число показывается, названий в ответе нет.
  const third = await ensureOrg(`Третья организация ${Date.now()}`);
  await pools.root.query(`insert into hdk_signature_orgs (signature_id, org_id) select signature_id, $2 from hdk_error_signatures where signature = $1`, [sig, third]);
  const shown = await search(f.aUser);
  expect(shown).toMatchObject([{ exact: true, orgCount: 3 }]);
  for (const name of ['Третья организация', f.orgA.name, f.orgB.name]) expect(JSON.stringify(shown)).not.toContain(name);
  // Решение стало внутренним: точного совпадения у клиента больше нет.
  await pools.root.query(`update hdk_articles set audience = 'internal' where article_id = $1`, [s.articleId]);
  expect(await search(f.aUser)).toEqual([]);
});

test('пункт 6: сервис векторов не отвечает или медлит, подсказка находит по словам и пишет событие', async () => {
  const s = await ORDER_STOCK();
  const events: [string, string, Record<string, unknown>][] = [];
  setLogSinkForTests((level, event, fields) => events.push([level, event, fields ?? {}]));
  const down: EmbeddingProvider = { name: 'tei', dimensions: 1024, embed: async () => Promise.reject(new EmbeddingUnavailableError('unreachable')) };
  setEmbedderForTests(down);
  const text = 'при сохранении заказа ошибка: нет остатка на складе';
  expect((await ask(text)).items.map((i) => i.number)).toEqual([s.number]);
  const words = await searchSolutions((await clientCtx(f.aUser)).actor, { text, signature: null, moduleId: null, locale: 'ru', audiences: ['clients'] });
  expect(words.mode).toBe('words');
  expect(events.filter((e) => e[1] === 'kb.suggest_embedder_unavailable')[0]).toMatchObject(['warn', 'kb.suggest_embedder_unavailable', { reason: 'unreachable' }]);
  expect(JSON.stringify(events)).not.toContain('остатка');
  // Медленный сервис: ожидание обрывается через 150 мс.
  const slow: EmbeddingProvider = {
    name: 'tei',
    dimensions: 1024,
    embed: (_texts, opts) =>
      new Promise((_resolve, reject) => setTimeout(() => reject(new EmbeddingUnavailableError('timeout')), Math.min(opts?.timeoutMs ?? 10_000, 5000))),
  };
  setEmbedderForTests(slow);
  const started = performance.now();
  expect((await ask(text)).items.map((i) => i.number)).toEqual([s.number]);
  expect(performance.now() - started).toBeLessThan(1500);
});

test('предел частоты: 60 запросов в минуту на пользователя, сверх предела блок не показывается', async () => {
  await ORDER_STOCK();
  const ctx = await clientCtx(f.aUser);
  for (let i = 0; i < 60; i++) expect((await suggestForClient(ctx, { text: `нет остатка ${i}`, sessionId: randomUUID(), locale: 'ru' })).limited).toBe(false);
  expect(await suggestForClient(ctx, { text: 'нет остатка на складе при сохранении заказа', sessionId: randomUUID(), locale: 'ru' })).toEqual({ items: [], limited: true });
  // Другой пользователь той же организации не задет (предел организации 600 в час).
  expect((await ask('при сохранении заказа ошибка: нет остатка на складе', randomUUID(), f.aAdmin)).items).toHaveLength(1);
  await expect(suggestForClient(ctx, { text: 'x'.repeat(501), sessionId: randomUUID(), locale: 'ru' })).rejects.toMatchObject({ code: 'invalid_input' });
});

test('исходы: одна строка на сессию формы, запрос только HMAC, помогло, не помогло, обращение создано', async () => {
  const s = await ORDER_STOCK();
  const session = randomUUID();
  const text = 'при сохранении заказа ошибка: нет остатка на складе';
  await ask(text, session);
  await ask(`${text}, что делать`, session);
  const rows = (await pools.root.query(`select * from hdk_deflection_events where session_id = $1`, [session])).rows;
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ org_id: f.orgA.orgId, user_id: f.aUser.userId, outcome: 'left', zone: 'portal', shown_article_ids: [s.articleId], ticket_id: null });
  expect(rows[0].query_hash).toMatch(/^[0-9a-f]{64}$/);
  expect(JSON.stringify(rows[0])).not.toContain('остатка');
  // Показ решения в сессии считается один раз.
  expect((await pools.root.query(`select shown_count from hdk_articles where article_id = $1`, [s.articleId])).rows[0].shown_count).toBe(1);
  // Чужая сессия: пользователь другой организации не меняет строку.
  await ask(text, session, f.bUser);
  await recordSuggestNotHelped(await clientCtx(f.bUser), { sessionId: session });
  expect((await pools.root.query(`select user_id, outcome from hdk_deflection_events where session_id = $1`, [session])).rows).toEqual([{ user_id: f.aUser.userId, outcome: 'left' }]);
  // "Помогло" со страницы решения с ?s= обновляет исход сессии (решение 12).
  await recordSolutionFeedback(await clientCtx(f.aUser), { number: s.number, outcome: 'helped', sessionId: session });
  expect((await pools.root.query(`select outcome from hdk_deflection_events where session_id = $1`, [session])).rows[0].outcome).toBe('helped');
  await recordSuggestNotHelped(await clientCtx(f.aUser), { sessionId: session });
  expect((await pools.root.query(`select outcome from hdk_deflection_events where session_id = $1`, [session])).rows[0].outcome).toBe('not_helped');
  await recordSuggestTicket(await clientCtx(f.aUser), { sessionId: session, ticketId: f.tickets.aOrg.ticketId });
  expect((await pools.root.query(`select outcome, ticket_id from hdk_deflection_events where session_id = $1`, [session])).rows[0]).toEqual({ outcome: 'ticket_created', ticket_id: f.tickets.aOrg.ticketId });
  // После создания обращения "не помогло" исход не меняет.
  await recordSuggestNotHelped(await clientCtx(f.aUser), { sessionId: session });
  expect((await pools.root.query(`select outcome from hdk_deflection_events where session_id = $1`, [session])).rows[0].outcome).toBe('ticket_created');
  // Без показа строки исходов нет.
  const empty = randomUUID();
  await ask('совсем другое описание без решений', empty);
  expect((await pools.root.query(`select 1 from hdk_deflection_events where session_id = $1`, [empty])).rowCount).toBe(0);
});

test('связанные решения сотрудника: по теме обращения среди решений для клиентов и внутренних', async () => {
  const open = await ORDER_STOCK();
  const inner = await solution('Ошибка остатка на складе при сохранении заказа', 'Остаток склада расходится при сохранении заказа', 'Пересчитайте остатки склада', { audience: 'internal' });
  await pools.root.query(`update hdt_tickets set title = 'Заказ не сохраняется: ошибка остатка на складе' where ticket_id = $1`, [f.tickets.aOrg.ticketId]);
  const related = await relatedSolutions(staffCtx(f.l1), { ticketId: f.tickets.aOrg.ticketId });
  expect(related.map((r) => r.number).sort()).toEqual([open.number, inner.number].sort());
  expect(related.find((r) => r.number === inner.number)?.audience).toBe('internal');
});

test('I6c: показанные в сессии решения копятся, показ считается один раз на решение, "Помогло" по решению, показанному раньше, засчитывается (0057)', async () => {
  const a = await ORDER_STOCK();
  const b = await solution('Чек не печатается на кассе', 'Касса не печатает чек после оплаты', 'Перезапустите принтер чеков');
  const session = randomUUID();
  const first = await ask('при сохранении заказа ошибка: нет остатка на складе', session);
  expect(first.items.map((i) => i.number)).toContain(a.number);
  const second = await ask('касса не печатает чек после оплаты', session);
  expect(second.items.map((i) => i.number)).toContain(b.number);
  await ask('при сохранении заказа ошибка: нет остатка на складе', session);
  const row = (await pools.root.query(`select shown_article_ids from hdk_deflection_events where session_id = $1`, [session])).rows[0];
  expect([...row.shown_article_ids].sort()).toEqual(expect.arrayContaining([a.articleId, b.articleId]));
  const counts = await pools.root.query(`select article_id, shown_count from hdk_articles where article_id = any($1::uuid[])`, [[a.articleId, b.articleId]]);
  for (const r of counts.rows) expect(r.shown_count, r.article_id).toBe(1);
  // Клиент открыл решение B, показанное раньше последнего показа, и нажал "Помогло".
  await ask('при сохранении заказа ошибка: нет остатка на складе', session);
  await recordSolutionFeedback(await clientCtx(f.aUser), { number: b.number, outcome: 'helped', sessionId: session });
  expect((await pools.root.query(`select outcome from hdk_deflection_events where session_id = $1`, [session])).rows[0].outcome).toBe('helped');
});
