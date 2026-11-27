import { afterEach, beforeEach, expect, test } from 'vitest';
import { setLogSinkForTests } from '@/lib/log';
import { handleMcpRequest } from '@/modules/hda/api/agent';
import { dispatchAgentEvents, handleAgentEvent, setAgentEventsForTests } from '@/modules/hda/api/agent-jobs';
import { codeAnalysisState, markAnalysisTimeouts, requestCodeAnalysis } from '@/modules/hda/api/code-analysis';
import { StubAgentEventSender } from '@/modules/hda/testing';
import { processEvents } from '@/modules/hdc/api';
import { getAgentTicket } from '@/modules/hdt/api/agent';
import { getTicket } from '@/modules/hdt/api';
import { createMcpClient } from '../helpers/mcp-client';
import { seedAgentToken } from './helpers/agent';
import { clientCtx, staffCtx, staffWithRole } from './helpers/auth';
import { seedCodeCatalog, type SeededCatalog } from './helpers/code';
import { pools } from './helpers/db';
import { type Fixture, seedTwoOrgs } from './isolation/fixture';

// "Разобрать по коду" (веха M8c, задача 7; ТЗ 7.22 FR-CODE-08, 10, FR-AGT-08, 12; сценарий S11, шаги 2-3; план M8c,
// решения 18-21). Вторая линия запрашивает анализ: запрос, событие предметной области и журнал аудита одной
// транзакцией; агент получает событие с токеном запуска на одно обращение, читает сохранённые выводы и пишет одну
// внутреннюю заметку, которую видят только сотрудники. Без ответа за 10 минут "анализ не выполнен".

const SYSTEM = { type: 'system', job: 'test.code-analysis' } as const;
const SECRET = 'agent-secret-'.repeat(4);
let f: Fixture;
let sender: StubAgentEventSender;
let catalog: SeededCatalog;

beforeEach(async () => {
  setLogSinkForTests(() => undefined);
  f = await seedTwoOrgs();
  sender = new StubAgentEventSender();
  setAgentEventsForTests({ url: 'https://hermes.example/events', secret: SECRET, sender });
  catalog = await seedCodeCatalog((await seedAgentToken()).tokenId, { approvedBy: f.adminStaff.userId });
});
afterEach(() => {
  setAgentEventsForTests(null);
  setLogSinkForTests(null);
});

const drain = () => processEvents(SYSTEM, (tx, event) => handleAgentEvent(tx, event));
const l2 = async () => staffCtx({ ...(await staffWithRole('agent_l2')), name: 'Вторая линия' });

/** Событие анализа доставлено: тело с токеном запуска. */
async function delivered() {
  await drain();
  await dispatchAgentEvents(SYSTEM);
  const body = sender.sent.map((s) => JSON.parse(s.body)).find((b) => b.kind === 'code_analysis_requested');
  return body as { kind: string; ticket: { number: number }; analysis_request: { id: string }; run_token?: { value: string; tools: string[] } } | undefined;
}

async function sideEffects(ticketId: string) {
  const q = async (sql: string, params: unknown[] = []) => (await pools.root.query(sql, params)).rows;
  return JSON.stringify({
    ticket: await q(`select status, priority, assignee_id, queue, first_response_due_on, resolution_due_on, client_waiting_since from hdt_tickets where ticket_id = $1`, [ticketId]),
    outbox: await q(`select count(*)::int as n from hdn_outbox`),
    notifications: await q(`select count(*)::int as n from hdn_notifications`),
    rules: await q(`select count(*)::int as n from hdw_rule_runs`),
  });
}

test('запрос второй линии: строка, событие и аудит одной транзакцией; повтор возвращает тот же; первой линии и product отказ', async () => {
  const t = f.tickets.aOrg;
  const ctx = await l2();
  const first = await requestCodeAnalysis(ctx, { number: t.number });
  expect(first).toMatchObject({ status: 'pending', requestedOn: expect.any(Date), dueOn: expect.any(Date) });
  expect(first.dueOn.getTime() - first.requestedOn.getTime()).toBe(10 * 60_000);
  const again = await requestCodeAnalysis(ctx, { number: t.number });
  expect(again.requestId).toBe(first.requestId);
  expect((await pools.root.query(`select kind, payload from hdc_domain_events where kind = 'code_analysis_requested'`)).rows).toEqual([
    { kind: 'code_analysis_requested', payload: { requestId: first.requestId } },
  ]);
  expect((await pools.root.query(`select actor_id from hdc_audit_log where action = 'code.analysis_requested' and object_id = $1`, [first.requestId])).rows).toEqual([{ actor_id: ctx.user.id }]);
  await expect(requestCodeAnalysis(staffCtx(f.l1), { number: t.number })).rejects.toMatchObject({ code: 'forbidden' });
  await expect(requestCodeAnalysis(staffCtx({ ...(await staffWithRole('product')), name: 'Продукт' }), { number: t.number })).rejects.toMatchObject({ code: 'forbidden' });
  // Организация без AI-обработки: агенту обращение не выдаётся.
  await pools.root.query(`update hdu_organizations set is_ai_enabled = false where org_id = $1`, [f.orgB.orgId]);
  await expect(requestCodeAnalysis(ctx, { number: f.tickets.bOrg.number })).rejects.toMatchObject({ code: 'ai_disabled' });
});

test('событие агенту с токеном запуска на одно обращение: тело без темы и текста; агент читает выводы и пишет одну заметку анализа', async () => {
  await seedAgentToken({ isEventParent: true, tools: ['get_ticket', 'add_internal_note', 'search_code_catalog', 'submit_code_analysis'] as never });
  const t = f.tickets.aOrg;
  const request = await requestCodeAnalysis(await l2(), { number: t.number });
  const body = await delivered();
  expect(body).toMatchObject({ kind: 'code_analysis_requested', ticket: { number: t.number }, analysis_request: { id: request.requestId } });
  expect(body!.run_token!.tools.sort()).toEqual(['get_ticket', 'search_code_catalog', 'submit_code_analysis']);
  for (const secret of [t.title, 'ACME', 'Алишер']) expect(JSON.stringify(body), secret).not.toContain(secret);

  const agent = createMcpClient({ token: body!.run_token!.value, ip: '10.0.3.12', send: (r) => handleMcpRequest(r) });
  const found = await agent.callTool('search_code_catalog', { key: catalog.approvedKey });
  expect(found.isError).toBeFalsy();
  const entries = (found.structuredContent as { entries: Record<string, unknown>[] }).entries;
  expect(entries).toMatchObject([{ key: catalog.approvedKey, status: 'approved', untrusted_text: { what_to_check: ['Остаток по товару на складе заказа', 'Включён ли контроль остатков'] } }]);
  expect(JSON.stringify(found.structuredContent)).not.toContain('pattern');

  const before = await sideEffects(t.ticketId);
  const answer = await agent.callTool('submit_code_analysis', {
    ticket_number: t.number,
    hypothesis: 'На складе заказа товара меньше, чем в заказе, при включённом контроле остатков.',
    confidence: 0.7,
    locations: [{ object: 'ORDER_PKG.SAVE_ORDER', path: 'db/packages/order_pkg.pkb', line: 412 }],
    what_to_check: ['Остаток товара на складе заказа', 'Настройку контроля остатков'],
    questions: ['На каком складе оформлен заказ?'],
    similar_tickets: [1001, 1002],
    recommendation: 'Проверить остаток и предложить клиенту выбрать другой склад.',
    entry_keys: [catalog.approvedKey],
  });
  expect(answer.isError).toBeFalsy();
  expect(await sideEffects(t.ticketId)).toBe(before);
  const [note] = (await pools.root.query(`select message_id, body, is_internal, author_type, agent_note_kind from hdt_ticket_messages where ticket_id = $1 and agent_note_kind = 'code_analysis'`, [t.ticketId])).rows;
  expect(note).toMatchObject({ is_internal: true, author_type: 'agent' });
  for (const part of ['Гипотеза', '70%', 'ORDER_PKG.SAVE_ORDER, db/packages/order_pkg.pkb:412', 'На каком складе оформлен заказ?', 'SUP-1001', catalog.approvedKey]) expect(note.body, part).toContain(part);
  const state = await codeAnalysisState(await l2(), { number: t.number });
  expect(state).toMatchObject({ status: 'done', noteMessageId: note.message_id });

  // Вторая заметка тем же токеном запуска отклонена.
  const second = await agent.callTool('submit_code_analysis', { ticket_number: t.number, hypothesis: 'Ещё одна', confidence: 0.1, locations: [], what_to_check: [], questions: [], similar_tickets: [], recommendation: '' });
  expect(JSON.parse(second.content[0]!.text)).toEqual({ error: 'note_limit' });
  // Клиент заметку анализа не видит; сотрудник видит её с пометкой AI-сотрудника.
  const client = await getTicket(await clientCtx(f.aUser), { number: t.number });
  expect(JSON.stringify(client)).not.toContain('Гипотеза');
  const staff = await getAgentTicket(staffCtx(f.care), t.number);
  expect(JSON.stringify(staff)).toContain('Гипотеза');
});

test('поле больше 10 строк в ответе отклонено; поздний ответ после срока принимается; без ответа запрос истекает', async () => {
  const main = await seedAgentToken({ tools: ['submit_code_analysis', 'search_code_catalog'] as never });
  const agent = createMcpClient({ token: main.value, ip: '10.0.3.12', send: (r) => handleMcpRequest(r) });
  const t = f.tickets.aOrg;
  const ctx = await l2();
  const request = await requestCodeAnalysis(ctx, { number: t.number });
  const args = { ticket_number: t.number, confidence: 0.5, locations: [], what_to_check: ['Остаток'], questions: [], similar_tickets: [], recommendation: 'Проверить' };
  const long = await agent.callTool('submit_code_analysis', { ...args, hypothesis: Array.from({ length: 11 }, (_, i) => `  v_qty := v_qty + ${i};`).join('\n') });
  expect(JSON.parse(long.content[0]!.text)).toEqual({ error: 'invalid_arguments' });
  expect((await pools.root.query(`select 1 from hdt_ticket_messages where agent_note_kind = 'code_analysis'`)).rowCount).toBe(0);

  // Срок вышел: задача ставит timeout, блок показывает "анализ не выполнен".
  expect(await markAnalysisTimeouts(SYSTEM, new Date(Date.now() + 11 * 60_000))).toEqual({ timedOut: 1 });
  expect(await codeAnalysisState(ctx, { number: t.number })).toMatchObject({ requestId: request.requestId, status: 'timeout' });
  // Поздний ответ принимается: гипотеза полезна и позже.
  const late = await agent.callTool('submit_code_analysis', { ...args, hypothesis: 'Поздняя гипотеза' });
  expect(late.isError).toBeFalsy();
  expect(await codeAnalysisState(ctx, { number: t.number })).toMatchObject({ status: 'done' });
  // Без запроса ответ не принимается.
  const none = await agent.callTool('submit_code_analysis', { ...args, ticket_number: f.tickets.aPrivate.number, hypothesis: 'Без запроса' });
  expect(JSON.parse(none.content[0]!.text)).toEqual({ error: 'not_found' });
});

test('search_code_catalog не отдаёт отклонённых и исчезнувших записей', async () => {
  const main = await seedAgentToken({ tools: ['search_code_catalog'] as never });
  const agent = createMcpClient({ token: main.value, ip: '10.0.3.12', send: (r) => handleMcpRequest(r) });
  await pools.root.query(`update hda_code_error_entries set status = 'rejected' where entry_id = $1`, [catalog.draftId]);
  await pools.root.query(`update hda_code_error_entries set status = 'removed', approved_by = null, approved_on = null where entry_id = $1`, [catalog.approvedId]);
  for (const key of [catalog.approvedKey, catalog.draftKey]) {
    const out = await agent.callTool('search_code_catalog', { key });
    expect((out.structuredContent as { entries: unknown[] }).entries, key).toEqual([]);
  }
});
