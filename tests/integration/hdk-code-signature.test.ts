import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, expect, test } from 'vitest';
import type { SystemActor } from '@/db/with-actor';
import { MemoryJobQueue, setJobQueueForTests } from '@/modules/hdc/testing';
import { createDraftArticle } from '@/modules/hdk/api/articles';
import { solutionEditorState } from '@/modules/hdk/api/editor';
import { publishSolution } from '@/modules/hdk/api/publish';
import { runIndexJob } from '@/modules/hdk/api/search-jobs';
import { resolveErrorSignature } from '@/modules/hdk/api/signature-text';
import { bindSolutionSignature, ticketSignatureRecorder } from '@/modules/hdk/api/signatures';
import { suggestForClient, suggestForWidget } from '@/modules/hdk/api/suggest';
import { setEmbedderForTests } from '@/modules/hdk/embeddings';
import { createStubEmbedder } from '@/modules/hdk/embeddings/stub';
import { errorSignature } from '@/modules/hdk/signature';
import { createTicket } from '@/modules/hdt/api';
import { seedAgentToken } from './helpers/agent';
import { clientCtx, staffCtx, staffWithRole } from './helpers/auth';
import { seedCodeCatalog, type SeededCatalog } from './helpers/code';
import { pools } from './helpers/db';
import { type Fixture, seedTwoOrgs } from './isolation/fixture';

// Точные сигнатуры по утверждённым шаблонам знаний из кода (веха M8c, задача 5; ТЗ 7.22 FR-CODE-04, 05, 11.5;
// строка приёмки M8c "Утверждённый шаблон определяет сигнатуру", сценарий 20 раздела 15.3; план M8c, решения 7, 8).
// Текст ошибки обращения совпал с утверждённым шаблоном: сигнатурой становится ключ записи. Нет совпадения: прежний
// способ 11.5. Обращение, подсказка, виджет, баннер и привязка сотрудником дают одну сигнатуру.

const SYSTEM: SystemActor = { type: 'system', job: 'kb.index' };
let f: Fixture;
let catalog: SeededCatalog;
let suffix: string;
let serial = 0;
const newId = () => `cs${String(++serial).padStart(10, '0')}`;
const p = (text: string) => ({ type: 'paragraph' as const, attrs: { id: newId() }, content: [{ type: 'text' as const, text }] });
const step = (text: string) => ({ type: 'step' as const, attrs: { id: newId() }, content: [p(text)] });

beforeEach(async () => {
  f = await seedTwoOrgs();
  setJobQueueForTests(new MemoryJobQueue());
  setEmbedderForTests(createStubEmbedder());
  await pools.root.query(`delete from hdc_rate_limits where code like 'kb-%' or code like 'ticket-create%'`);
  await pools.root.query(`insert into hdc_settings (code, value) values ('kb.allowed_domains', '["smartup.uz"]') on conflict (code) do update set value = excluded.value`);
  const token = await seedAgentToken();
  catalog = await seedCodeCatalog(token.tokenId, { approvedBy: f.adminStaff.userId });
  suffix = catalog.approvedKey.split('_').slice(-2).join('_');
});
afterEach(() => {
  setJobQueueForTests(null);
  setEmbedderForTests(null);
});

const report = async (member: { userId: string }, description: string) => createTicket(await clientCtx(member), { description, type: 'bug', impact: 'minor', locale: 'ru' });
const ticketSignature = async (ticketId: string) => (await pools.root.query(`select error_signature from hdt_tickets where ticket_id = $1`, [ticketId])).rows[0].error_signature as string | null;
const stockLine = (product: string, warehouse: string) => `Недостаточно остатка товара ${product} на складе ${warehouse} ${suffix}`;

test('утверждённый шаблон определяет сигнатуру нового обращения: строка с кодом, строка без кода, контекст виджета', async () => {
  const withCode = await report(f.aUser, `Добрый день.\nORA-20001: ${stockLine('"Молоко 1л"', 'Основной')}\nORA-06512: at "SALES.ORDER", line 120`);
  expect(await ticketSignature(withCode.ticketId)).toBe(catalog.approvedSignature);
  const plain = await report(f.bUser, `Не сохраняется заказ, пишет:\n${stockLine('Хлеб', 'Север')}.`);
  expect(await ticketSignature(plain.ticketId)).toBe(catalog.approvedSignature);
  // Контекст виджета: код и текст ошибки отдельными полями.
  const widget = await report(f.aAdmin, 'Ошибка при сохранении');
  const recorded = await ticketSignatureRecorder.recordTicket({
    ticketId: widget.ticketId,
    orgId: f.orgA.orgId,
    authorId: f.aAdmin.userId,
    description: 'Ошибка при сохранении',
    context: { errorCode: 'ORA-20001', errorText: stockLine('Сыр', 'Юг') },
    moduleId: null,
  });
  expect(recorded).toBe(catalog.approvedSignature);
  // Встреча записана в сигнатуры с числом организаций: решения и проблемы работают с ней как с любой другой.
  const [row] = (await pools.root.query(`select org_count, occurrences from hdk_error_signatures where signature = $1`, [catalog.approvedSignature])).rows;
  expect(row).toMatchObject({ org_count: 2 });
});

test('черновик, отклонённая и исчезнувшая запись сигнатуры не дают; другой код ошибки тоже: работает способ 11.5', async () => {
  const draftLine = `Отрицательный остаток товара Сок ${suffix}`;
  const draft = await report(f.aUser, `ORA-20001: ${draftLine}`);
  expect(await ticketSignature(draft.ticketId)).toBe(errorSignature({ errorCode: 'ORA-20001', errorMessage: draftLine }));
  const otherCode = await report(f.aUser, `ORA-01403: ${stockLine('Сыр', 'Юг')}`);
  expect(await ticketSignature(otherCode.ticketId)).not.toBe(catalog.approvedSignature);
  for (const status of ['rejected', 'removed']) {
    await pools.root.query(`update hda_code_error_entries set status = $2, approved_by = null, approved_on = null where entry_id = $1`, [catalog.approvedId, status]);
    const ticket = await report(f.bUser, `ORA-20001: ${stockLine('Мука', 'Запад')}`);
    expect(await ticketSignature(ticket.ticketId), status).not.toBe(catalog.approvedSignature);
  }
});

test('подсказка на портале и в виджете, баннер и привязка сотрудником дают ту же сигнатуру; решение находится точным совпадением', async () => {
  expect((await resolveErrorSignature({ text: `Выходит ORA-20001: ${stockLine('Чай', 'Восток')}` }))?.signature).toBe(catalog.approvedSignature);
  expect((await resolveErrorSignature({ text: '', errorCode: 'ORA-20001', errorText: stockLine('Чай', 'Восток') }))?.signature).toBe(catalog.approvedSignature);
  expect((await resolveErrorSignature({ text: 'Просто вопрос без ошибки' }))?.signature ?? null).toBeNull();

  const moduleId = (await pools.root.query(`insert into hdr_product_modules (code, name) values ($1, '{"ru": "Заказы"}') returning module_id`, [`code-sig-${Date.now()}-${Math.random()}`])).rows[0].module_id as string;
  const created = await createDraftArticle(staffCtx(f.l1), { locale: 'ru', title: 'Не хватает остатка при сохранении заказа', audience: 'clients', moduleId, doc: { version: 1, blocks: [p('При сохранении заказа не хватает товара'), step('Проверьте остаток')] } });
  // Привязка сотрудником по тексту ошибки даёт сигнатуру записи.
  expect(await bindSolutionSignature(staffCtx(f.l1), { number: created.number, errorText: `ORA-20001: ${stockLine('Кофе', 'Центр')}` })).toEqual({ status: 'bound' });
  const [bound] = (await pools.root.query(`select signature from hdk_error_signatures where article_id = $1`, [created.articleId])).rows;
  expect(bound.signature).toBe(catalog.approvedSignature);
  const state = await solutionEditorState(staffCtx(f.l1), { number: created.number });
  const l2 = staffCtx(await staffWithRole('agent_l2'));
  expect((await publishSolution(l2, { number: created.number, locale: 'ru', versionId: state!.current.versionId, revision: state!.current.revision, confirmFindings: false })).status).toBe('published');
  await runIndexJob(SYSTEM, { articleId: created.articleId });

  const portal = await suggestForClient(await clientCtx(f.bUser), { text: `Не могу сохранить, ORA-20001: ${stockLine('Рис', 'Склад 2')}`, sessionId: randomUUID(), locale: 'ru' });
  expect(portal.items[0]).toMatchObject({ number: created.number, exact: true });
  const widget = await suggestForWidget(await clientCtx(f.bUser), { text: '', sessionId: randomUUID(), locale: 'ru', errorCode: 'ORA-20001', errorText: stockLine('Рис', 'Склад 2') });
  expect(widget.items[0]).toMatchObject({ number: created.number, exact: true });
});
