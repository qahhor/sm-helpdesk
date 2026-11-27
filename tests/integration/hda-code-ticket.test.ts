import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { codeKnowledgeMetrics, createSolutionFromCodeEntry, ticketCodeKnowledge } from '@/modules/hda/api/code-knowledge';
import { MemoryJobQueue, setJobQueueForTests } from '@/modules/hdc/testing';
import { solutionEditorState } from '@/modules/hdk/api/editor';
import { suggestForClient } from '@/modules/hdk/api/suggest';
import { setEmbedderForTests } from '@/modules/hdk/embeddings';
import { createStubEmbedder } from '@/modules/hdk/embeddings/stub';
import { createTicket } from '@/modules/hdt/api';
import { seedAgentToken } from './helpers/agent';
import { clientCtx, staffCtx, staffWithRole } from './helpers/auth';
import { seedCodeCatalog, type SeededCatalog } from './helpers/code';
import { pools } from './helpers/db';
import { type Fixture, seedTwoOrgs } from './isolation/fixture';

// Блок "Что известно по коду" и решение из записи (веха M8c, задача 6; ТЗ 7.22 FR-CODE-06, 07, 11, FR-SOL-04, 8.12;
// план M8c, решения 16, 17). Вторая линия видит утверждённую запись по сигнатуре и черновик по шаблону с пометкой "не
// проверено"; первая линия только "что проверить" утверждённой; product ничего. Черновик решения из записи без
// внутренних имён: ни ключа, ни объектов, ни путей, ни условий.

let f: Fixture;
let catalog: SeededCatalog;
let suffix: string;
const LABELS = { what: 'Что видит пользователь', why: 'Почему так происходит', do: 'Что сделать' };
let serial = 0;
const newId = () => `ct${String(++serial).padStart(10, '0')}`;

beforeEach(async () => {
  f = await seedTwoOrgs();
  setJobQueueForTests(new MemoryJobQueue());
  setEmbedderForTests(createStubEmbedder());
  await pools.root.query(`delete from hdc_rate_limits where code like 'kb-%' or code like 'ticket-create%'`);
  const token = await seedAgentToken();
  catalog = await seedCodeCatalog(token.tokenId, { approvedBy: f.adminStaff.userId });
  suffix = catalog.approvedKey.split('_').slice(-2).join('_');
});
afterEach(() => {
  setJobQueueForTests(null);
  setEmbedderForTests(null);
});

const report = async (member: { userId: string }, description: string) => createTicket(await clientCtx(member), { description, type: 'bug', impact: 'minor', locale: 'ru' });

test('вторая линия видит утверждённую запись по сигнатуре и черновик по шаблону с пометкой; первая линия только "что проверить"; product ничего', async () => {
  const ticket = await report(f.aUser, `ORA-20001: Недостаточно остатка товара Молоко на складе Основной ${suffix}\nОтрицательный остаток товара Сок ${suffix}`);
  const l2 = staffCtx({ ...(await staffWithRole('agent_l2')), name: 'Вторая' });
  const full = await ticketCodeKnowledge(l2, { number: ticket.number });
  expect(full.view).toBe('full');
  if (full.view !== 'full') throw new Error('view');
  const byKey = Object.fromEntries(full.entries.map((e) => [e.key, e]));
  expect(byKey[catalog.approvedKey]).toMatchObject({ status: 'approved', conditions: 'Количество больше остатка при контроле остатков', whatToCheck: ['Остаток по товару на складе заказа', 'Включён ли контроль остатков'] });
  expect(byKey[catalog.draftKey]).toMatchObject({ status: 'draft' });
  expect(byKey[catalog.approvedKey]!.raisedIn).toEqual([{ object: 'ORDER_PKG.SAVE_ORDER', path: 'db/packages/order_pkg.pkb', line: 412 }]);
  expect(full.canCreateSolution).toBe(true);

  const l1 = await ticketCodeKnowledge(staffCtx(f.l1), { number: ticket.number });
  expect(l1).toEqual({ view: 'checks', checks: [{ key: catalog.approvedKey, whatToCheck: ['Остаток по товару на складе заказа', 'Включён ли контроль остатков'] }] });
  expect(JSON.stringify(l1)).not.toMatch(/ORDER_PKG|order_pkg|Количество больше|Отрицательный/);
  const product = staffCtx({ ...(await staffWithRole('product')), name: 'Продукт' });
  expect(await ticketCodeKnowledge(product, { number: ticket.number })).toEqual({ view: 'none' });
  // Обращение без ошибки: пусто, но блок есть.
  const plain = await report(f.aUser, 'Как поменять пароль?');
  expect(await ticketCodeKnowledge(l2, { number: plain.number })).toMatchObject({ view: 'full', entries: [] });
});

test('решение из записи: черновик internal с недоверенным текстом без внутренних имён, сигнатура привязана, аудит; подсказка его не находит до публикации', async () => {
  const l2 = staffCtx({ ...(await staffWithRole('agent_l2')), name: 'Вторая' });
  const before = await codeKnowledgeMetrics(l2, { days: 30 });
  const { number } = await createSolutionFromCodeEntry(l2, { key: catalog.approvedKey, locale: 'ru' }, LABELS, newId);
  const [article] = (await pools.root.query(`select article_id, audience, is_untrusted, code_entry_id from hdk_articles where number = $1`, [number])).rows;
  expect(article).toMatchObject({ audience: 'internal', is_untrusted: true, code_entry_id: catalog.approvedId });
  const state = await solutionEditorState(l2, { number });
  const text = JSON.stringify({ title: state!.current.title, doc: state!.current.doc });
  expect(state!.current.title).toBe(`Недостаточно остатка товара ... на складе ... ${suffix}`);
  expect(text).toContain('На складе меньше товара, чем в заказе');
  expect(text).toContain('Остаток по товару на складе заказа');
  for (const internal of [catalog.approvedKey, 'ORDER_PKG', 'SAVE_ORDER', 'order_pkg.pkb', 'db/packages', 'Количество больше остатка', 'ORA-20001']) expect(text, internal).not.toContain(internal);
  const [bound] = (await pools.root.query(`select article_id from hdk_error_signatures where signature = $1`, [catalog.approvedSignature])).rows;
  expect(bound.article_id).toBe(article.article_id);
  expect((await pools.root.query(`select diff from hdc_audit_log where action = 'solution.created_from_code' and object_id = $1`, [article.article_id])).rows).toEqual([
    { diff: { number, entry: catalog.approvedKey } },
  ]);
  expect((await codeKnowledgeMetrics(l2, { days: 30 })).solutionsFromEntries - before.solutionsFromEntries).toBe(1);
  // До публикации подсказка черновик не находит, даже точным совпадением сигнатуры.
  const found = await suggestForClient(await clientCtx(f.bUser), { text: `ORA-20001: Недостаточно остатка товара Рис на складе Юг ${suffix}`, sessionId: randomUUID(), locale: 'ru' });
  expect(found.items.map((i) => i.number)).not.toContain(number);
  // Проверка перед публикацией находит объект и путь записи, если сотрудник их вписал.
  expect(state!.review.findings.filter((x) => x.kind === 'internal')).toEqual([]);
});

test('проверка перед публикацией решения из записи находит объекты и пути записи (FR-CODE-07, FR-SOL-04)', async () => {
  const l2 = staffCtx({ ...(await staffWithRole('agent_l2')), name: 'Вторая' });
  const { number } = await createSolutionFromCodeEntry(l2, { key: catalog.approvedKey, locale: 'ru' }, LABELS, newId);
  const { saveSolutionDraft } = await import('@/modules/hdk/api/editor');
  const state = await solutionEditorState(l2, { number });
  const doc = structuredClone(state!.current.doc) as { blocks: { type: string; content?: { type: string; text?: string }[] }[] };
  doc.blocks.push({ type: 'paragraph', attrs: { id: newId() }, content: [{ type: 'text', text: 'Ошибка в Save_Order, смотрите order_pkg.pkb' }] } as never);
  const saved = await saveSolutionDraft(l2, { number, locale: 'ru', versionId: state!.current.versionId, title: state!.current.title, doc, revision: state!.current.revision });
  const internal = (saved as { review: { findings: { kind: string; text: string }[] } }).review.findings.filter((x) => x.kind === 'internal').map((x) => x.text.toLowerCase());
  expect(internal).toEqual(expect.arrayContaining(['save_order', 'order_pkg.pkb']));
});

test('создать решение из записи могут agent_l2, care, admin и только из утверждённой', async () => {
  const product = staffCtx({ ...(await staffWithRole('product')), name: 'Продукт' });
  await expect(createSolutionFromCodeEntry(staffCtx(f.l1), { key: catalog.approvedKey, locale: 'ru' }, LABELS, newId)).rejects.toMatchObject({ code: 'forbidden' });
  await expect(createSolutionFromCodeEntry(product, { key: catalog.approvedKey, locale: 'ru' }, LABELS, newId)).rejects.toMatchObject({ code: 'forbidden' });
  await expect(createSolutionFromCodeEntry(staffCtx(f.care), { key: catalog.draftKey, locale: 'ru' }, LABELS, newId)).rejects.toMatchObject({ code: 'not_found' });
  await expect(createSolutionFromCodeEntry(staffCtx(f.care), { key: catalog.approvedKey, locale: 'ru' }, LABELS, newId)).resolves.toMatchObject({ number: expect.any(Number) });
});
