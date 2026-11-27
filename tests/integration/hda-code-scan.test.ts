import { afterEach, beforeEach, expect, test } from 'vitest';
import { setLogSinkForTests } from '@/lib/log';
import { handleMcpRequest } from '@/modules/hda/api/agent';
import { sendTeamChatMessages } from '@/modules/hda/api/digests';
import { setOncallBotFactoryForTests } from '@/modules/hdn/api/oncall';
import { codeLines, uniqueReport } from '../helpers/code-scan';
import { createMcpClient } from '../helpers/mcp-client';
import { seedAgentToken } from './helpers/agent';
import { seedStaff } from './helpers/code';
import { pools } from './helpers/db';
import { seedTwoOrgs } from './isolation/fixture';

// Приём отчёта о сканировании инструментом code_catalog_upsert сервера MCP (веха M8c, задача 3; ТЗ 7.22 FR-CODE-01,
// 03, 05, 12, 13, 14, FR-AGT-04; строка приёмки M8c "Отчёт с кодом длиннее 10 строк или с регулярным выражением
// отклонён"; план M8c, решения 3, 5, 10, 11, 14, 15).

const SYSTEM = { type: 'system', job: 'test.code-scan' } as const;
const sent: { chatId: string; text: string }[] = [];

beforeEach(() => {
  setLogSinkForTests(() => undefined);
  sent.length = 0;
  setOncallBotFactoryForTests(() => ({ send: async (chatId, text) => void sent.push({ chatId, text }) }));
});
afterEach(() => {
  setOncallBotFactoryForTests(null);
  setLogSinkForTests(null);
});

type Result = { isError?: boolean; content: { text: string }[]; structuredContent?: Record<string, unknown> };

async function agent(tools: string[] = ['code_catalog_upsert']) {
  const token = await seedAgentToken({ tools: tools as never });
  const client = createMcpClient({ token: token.value, ip: '10.0.3.12', send: (request) => handleMcpRequest(request) });
  const call = async (args: Record<string, unknown>) => (await client.callTool('code_catalog_upsert', args)) as Result;
  const ok = async (args: Record<string, unknown>) => {
    const result = await call(args);
    if (result.isError) throw new Error(result.content[0]!.text);
    return result.structuredContent as Record<string, unknown>;
  };
  return { token, client, call, ok };
}

const q = async (sql: string, params: unknown[] = []) => (await pools.root.query(sql, params)).rows;
const entriesOf = (repository: string) =>
  q(`select key, status, change_kind, conditions, approved_by from hda_code_error_entries where repository = $1 order by key`, [repository]);

test('отчёт-пример принят: записи черновиками, шаблоны с выражением от базы, история с числами, журнал вызова и аудит', async () => {
  await seedTwoOrgs();
  const { token, ok } = await agent();
  const report = uniqueReport();
  const out = await ok(report);
  expect(out).toMatchObject({ status: 'accepted', scan_key: report.scanId, added: 3, changed: 0, removed: 0, unchanged: 0, modules: { added: 2, changed: 0, removed: 0 }, duplicate: false });
  const entries = await entriesOf(report.repository);
  expect(entries.map((e) => [e.status, e.change_kind])).toEqual([
    ['draft', 'new'],
    ['draft', 'new'],
    ['draft', 'new'],
  ]);
  const [templates] = await q(
    `select count(*)::int as n, bool_and(left(pattern, 4) = '^\\s*') as built from hda_code_error_templates t join hda_code_error_entries e using (entry_id) where e.repository = $1`,
    [report.repository],
  );
  expect(templates).toEqual({ n: 5, built: true });
  const [scan] = await q(`select status, added_count, changed_count, removed_count, error_count, module_count, commit_ref from hda_code_scans where repository = $1`, [report.repository]);
  expect(scan).toEqual({ status: 'accepted', added_count: 3, changed_count: 0, removed_count: 0, error_count: 3, module_count: 2, commit_ref: 'abc1234' });
  // Модуль заказов известен справочнику только после утверждения: у записи код модуля, ссылки нет.
  const notes = await q(`select module_code, status, screens from hda_code_module_notes where repository = $1 order by module_code`, [report.repository]);
  expect(notes.map((n) => n.status)).toEqual(['draft', 'draft']);
  expect(await q(`select status from hda_agent_tool_calls where token_id = $1 and tool = 'code_catalog_upsert'`, [token.tokenId])).toEqual([{ status: 'ok' }]);
  const audit = await q(`select action from hdc_audit_log where actor_id = $1 and action in ('agent.tool_called', 'code.scan_accepted') order by action`, [token.userId]);
  expect(audit.map((a) => a.action)).toEqual(['agent.tool_called', 'code.scan_accepted']);
});

test('повтор того же scanId ничего не меняет и возвращает прежний итог', async () => {
  await seedTwoOrgs();
  const { ok } = await agent();
  const report = uniqueReport();
  await ok(report);
  const again = await ok(report);
  expect(again).toMatchObject({ status: 'accepted', added: 3, duplicate: true });
  expect((await q(`select 1 from hda_code_scans where repository = $1`, [report.repository])).length).toBe(1);
});

test('следующее сканирование: новые, изменённые и исчезнувшие; утверждённая изменённая снова черновик, неизменная с правкой сотрудника остаётся', async () => {
  await seedTwoOrgs();
  const l2 = await seedStaff('agent_l2');
  const { ok } = await agent();
  const first = uniqueReport();
  await ok(first);
  const [stock, routes, orders] = [first.errors[1]!.key, first.errors[2]!.key, first.errors[0]!.key];
  // Сотрудник утвердил две записи и поправил условия у одной из них.
  await pools.root.query(`update hda_code_error_entries set status = 'approved', approved_by = $2, approved_on = now() where key = any($1)`, [[orders, stock], l2.userId]);
  await pools.root.query(`update hda_code_error_entries set conditions = 'Правка сотрудника' where key = $1`, [orders]);

  const second = structuredClone(first);
  second.scanId = `${first.scanId}-2`;
  second.commit = 'def5678';
  second.errors[1]!.conditions = 'Агент уточнил условия';
  second.errors = second.errors.filter((e) => e.key !== routes);
  second.errors.push({ ...structuredClone(first.errors[2]!), key: `${routes}_new` });
  const out = await ok(second);
  expect(out).toMatchObject({ status: 'accepted', added: 1, changed: 1, removed: 1, unchanged: 1 });
  const entries = Object.fromEntries((await entriesOf(first.repository)).map((e) => [e.key, e]));
  expect(entries[orders]).toMatchObject({ status: 'approved', change_kind: 'same', conditions: 'Правка сотрудника', approved_by: l2.userId });
  expect(entries[stock]).toMatchObject({ status: 'draft', change_kind: 'changed', conditions: 'Агент уточнил условия', approved_by: null });
  expect(entries[routes]).toMatchObject({ status: 'removed' });
  expect(entries[`${routes}_new`]).toMatchObject({ status: 'draft', change_kind: 'new' });
  const [scan] = await q(`select added_count, changed_count, removed_count from hda_code_scans where scan_key = $1`, [second.scanId]);
  expect(scan).toEqual({ added_count: 1, changed_count: 1, removed_count: 1 });
  // Вернувшаяся запись снова черновик "новое".
  const third = structuredClone(first);
  third.scanId = `${first.scanId}-3`;
  expect(await ok(third)).toMatchObject({ added: 1 });
  expect(Object.fromEntries((await entriesOf(first.repository)).map((e) => [e.key, e]))[routes]).toMatchObject({ status: 'draft', change_kind: 'new' });
});

test('отчёт с полем больше 10 строк и отчёт с регулярным выражением отклонены: в базе только строка истории с причинами без значений', async () => {
  await seedTwoOrgs();
  const { token, ok } = await agent();
  const longCode = uniqueReport();
  longCode.errors[0]!.conditions = codeLines(11);
  const withRegex = uniqueReport();
  withRegex.errors[1]!.messageTemplates.ru = 'Отрицательный остаток .* на дату \\d+';
  for (const [report, rule] of [
    [longCode, 'code_too_long'],
    [withRegex, 'regex'],
  ] as const) {
    const out = await ok(report);
    expect(out).toMatchObject({ status: 'rejected', reasons: expect.arrayContaining([expect.objectContaining({ rule })]) });
    expect(await entriesOf(report.repository)).toEqual([]);
    expect(await q(`select 1 from hda_code_module_notes where repository = $1`, [report.repository])).toEqual([]);
    const [scan] = await q(`select status, reject_reasons from hda_code_scans where repository = $1`, [report.repository]);
    expect(scan.status).toBe('rejected');
    const stored = JSON.stringify(scan.reject_reasons);
    for (const secret of ['v_qty', 'Отрицательный', '\\d']) expect(stored).not.toContain(secret);
  }
  expect((await q(`select action from hdc_audit_log where actor_id = $1 and action = 'code.scan_rejected'`, [token.userId])).length).toBe(2);
});

test('выражение от агента не принимается: поле pattern делает вызов неверным, ничего не пишется', async () => {
  await seedTwoOrgs();
  const { token, call } = await agent();
  const report = uniqueReport() as unknown as { repository: string; errors: Record<string, unknown>[] };
  report.errors[0]!.pattern = '^Недостаточно .*$';
  const result = await call(report as never);
  expect(result.isError).toBe(true);
  expect(JSON.parse(result.content[0]!.text)).toEqual({ error: 'invalid_arguments' });
  expect(await q(`select 1 from hda_code_scans where repository = $1`, [report.repository])).toEqual([]);
  expect(await q(`select status from hda_agent_tool_calls where token_id = $1`, [token.tokenId])).toEqual([{ status: 'invalid' }]);
});

test('большой отчёт проходит только у токена с code_catalog_upsert; токену запуска и токену без инструмента отказ', async () => {
  const f = await seedTwoOrgs();
  const big = uniqueReport();
  const template = structuredClone(big.errors[0]!);
  big.errors = Array.from({ length: 400 }, (_, i) => ({ ...structuredClone(template), key: `${template.key}.e${i}` }));
  big.changes = { added: [], changed: [], removed: [] };
  expect(JSON.stringify(big).length).toBeGreaterThan(64 * 1024);
  const { ok } = await agent();
  expect(await ok(big)).toMatchObject({ status: 'accepted', added: 400 });

  const other = await agent(['get_ticket']);
  const tooLarge = await other.client.raw(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'code_catalog_upsert', arguments: big } }));
  expect(tooLarge.status).toBe(413);

  const main = await seedAgentToken({ tools: ['get_ticket', 'code_catalog_upsert'] as never });
  const run = await seedAgentToken({ userId: main.userId, parentTokenId: main.tokenId, ticketId: f.tickets.aOrg.ticketId });
  const runClient = createMcpClient({ token: run.value, ip: '10.0.3.12', send: (request) => handleMcpRequest(request) });
  const refused = await runClient.callTool('code_catalog_upsert', uniqueReport());
  expect(JSON.parse(refused.content[0]!.text)).toEqual({ error: 'tool_not_allowed' });
});

test('сводка о сканировании в чат команды собрана из чисел без текста агента; без настройки чата ничего не уходит', async () => {
  await seedTwoOrgs();
  const { ok } = await agent();
  const report = uniqueReport();
  report.errors[0]!.conditions = 'СЕКРЕТНЫЙ ТЕКСТ АГЕНТА';
  await ok(report);
  await pools.root.query(`delete from hdc_settings where code = 'agent.team_chat_id'`);
  await sendTeamChatMessages(SYSTEM);
  expect(sent).toEqual([]);
  await pools.root.query(`insert into hdc_settings (code, value) values ('agent.team_chat_id', '"-1001234567"')`);
  await sendTeamChatMessages(SYSTEM);
  const message = sent.find((m) => m.text.includes(report.repository));
  expect(message).toBeDefined();
  expect(message!.text).toContain('3');
  expect(message!.text).toContain('/agent/code-knowledge');
  for (const secret of ['СЕКРЕТНЫЙ', 'Недостаточно', 'ORDER_PKG']) expect(message!.text).not.toContain(secret);
  // Повтора нет.
  sent.length = 0;
  await sendTeamChatMessages(SYSTEM);
  expect(sent.find((m) => m.text.includes(report.repository))).toBeUndefined();
});
