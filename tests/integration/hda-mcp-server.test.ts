import { createHash } from 'node:crypto';
import { getGlobalDispatcher, MockAgent, setGlobalDispatcher } from 'undici';
import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'vitest';
import { setLogSinkForTests } from '@/lib/log';
import { getAppPool } from '@/db/client';
import { acquireMcpSlot, setMcpInflightLimitForTests } from '@/modules/hda/agent/inflight';
import { handleMcpRequest, setAgentServerSettingsForTests } from '@/modules/hda/api/agent';
import { createMcpClient } from '../helpers/mcp-client';
import { seedAgentToken } from './helpers/agent';
import { pools } from './helpers/db';
import { seedTwoOrgs } from './isolation/fixture';

// Сервер MCP: вход, перечень, пределы, журнал (веха M8b, задача 4; FR-AGT-01, 02, 05, 09, 10, T27; строки 15.2
// "Агент вызывает инструмент вне перечня токена" и приёмки M8b; план M8b, решения 4, 11-14, 29-31; решение 0110).
// Тестовый клиент вызывает обработчик маршрута напрямую. Исходящих соединений нет: сервер MCP в сеть не ходит.

const IP = '10.0.3.12';
const events: { event: string; fields: Record<string, unknown> }[] = [];
const previous = getGlobalDispatcher();

beforeAll(() => {
  const mock = new MockAgent();
  mock.disableNetConnect();
  setGlobalDispatcher(mock);
});
afterAll(() => setGlobalDispatcher(previous));
beforeEach(() => {
  events.length = 0;
  setLogSinkForTests((_level, event, fields) => void events.push({ event, fields: (fields ?? {}) as Record<string, unknown> }));
  setAgentServerSettingsForTests(null);
});
afterEach(() => {
  setLogSinkForTests(null);
  setAgentServerSettingsForTests(null);
});

const client = (token: string | null, ip = IP) => createMcpClient({ token, ip, send: (request) => handleMcpRequest(request) });
const calls = async (tokenId: string) =>
  (await pools.root.query(`select tool, status, args_digest, object_refs, duration_ms from hda_agent_tool_calls where token_id = $1 order by created_on, call_id`, [tokenId])).rows;
const errorOf = (result: { isError?: boolean; content: { text: string }[] }) => (result.isError ? (JSON.parse(result.content[0]!.text) as { error: string; retry_after_sec?: number }) : null);

test('initialize и tools/list показывают ровно инструменты токена, ответ без кеша', async () => {
  const one = await seedAgentToken({ tools: ['list_known_problems'] });
  const two = await seedAgentToken({ tools: ['list_known_problems', 'list_ideas'] });
  const a = client(one.value);
  const init = await a.initialize();
  expect(init).toMatchObject({ protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'smartup-hub' } });
  expect((await a.listTools()).map((tool) => tool.name)).toEqual(['list_known_problems']);
  expect((await client(two.value).listTools()).map((tool) => tool.name)).toEqual(['list_known_problems', 'list_ideas']);
  const reply = await a.rpc('tools/list');
  expect(reply.headers.get('cache-control')).toBe('private, no-store');
  expect(reply.headers.get('content-type')).toMatch(/^application\/json/);
  expect(reply.headers.get('mcp-session-id')).toBeNull();
  // Вызов разрешённого инструмента: результат по схеме, тот же JSON текстом, постоянное поле notice.
  const result = await a.callTool('list_known_problems', {});
  expect(result.isError).toBeFalsy();
  expect(result.structuredContent).toMatchObject({ notice: expect.stringMatching(/untrusted_/), items: [] });
  expect(JSON.parse(result.content[0]!.text)).toEqual(result.structuredContent);
});

test('без токена, с неверным, неизвестным, истёкшим и отозванным токеном: 401 без подробностей', async () => {
  const expired = await seedAgentToken({ expiresIn: '-1 minute' });
  const revoked = await seedAgentToken({ revoked: true });
  const unknown = `hub_at_${'A'.repeat(43)}`;
  for (const token of [null, 'hub_at_short', unknown, expired.value, revoked.value]) {
    const reply = await client(token).rpc('tools/list');
    expect(reply.status, String(token)).toBe(401);
    expect(reply.headers.get('www-authenticate')).toBe('Bearer');
    expect(JSON.stringify(reply.body)).not.toMatch(/expired|revoked|истёк|отозван/i);
  }
  // Учётная запись agent_bot выключена: токен не действует.
  const main = await seedAgentToken();
  await pools.root.query(`update hdu_staff set state = 'passive' where user_id = $1`, [main.userId]);
  expect((await client(main.value).rpc('tools/list')).status).toBe(401);
});

test('адрес вне списка токена или вне MCP_ALLOWED_IPS: 403, отказ в журнале вызовов и событие mcp.denied', async () => {
  const main = await seedAgentToken({ allowedIps: ['10.0.3.0/24'] });
  const reply = await client(main.value, '192.168.1.5').rpc('tools/list');
  expect(reply.status).toBe(403);
  expect(await calls(main.tokenId)).toEqual([expect.objectContaining({ tool: 'connect', status: 'refused' })]);
  expect(events.find((e) => e.event === 'mcp.denied')?.fields).toMatchObject({ tokenId: main.tokenId, reason: 'token_ip' });
  expect((await client(main.value, '10.0.3.77').rpc('tools/list')).status).toBe(200);

  setAgentServerSettingsForTests({ allowedIps: ['10.0.9.0/24'] });
  const outside = await client(main.value, '10.0.3.77').rpc('tools/list');
  expect(outside.status).toBe(403);
  expect(events.filter((e) => e.event === 'mcp.denied').at(-1)?.fields).toMatchObject({ reason: 'server_ip' });
  // Без адреса запроса вход закрыт.
  expect((await createMcpClient({ token: main.value, send: (r) => handleMcpRequest(r) }).rpc('tools/list')).status).toBe(403);
});

test('вызов инструмента вне перечня отклоняется tool_not_allowed, пишет журнал вызовов refused и аудит в одной транзакции', async () => {
  const main = await seedAgentToken({ tools: ['list_known_problems'] });
  const a = client(main.value);
  for (const name of ['list_ideas', 'reply_to_client']) {
    const result = await a.callTool(name, { limit: 5 });
    expect(errorOf(result)).toEqual({ error: 'tool_not_allowed' });
  }
  const rows = await calls(main.tokenId);
  expect(rows.map((r) => [r.tool, r.status])).toEqual([
    ['list_ideas', 'refused'],
    ['reply_to_client', 'refused'],
  ]);
  const audit = (
    await pools.root.query(`select object_type, object_id, diff, actor_type, created_on from hdc_audit_log where action = 'agent.tool_refused' order by created_on`)
  ).rows;
  expect(audit.map((r) => r.diff.tool)).toEqual(['list_ideas', 'reply_to_client']);
  expect(audit[0]).toMatchObject({ object_type: 'agent_token', object_id: main.tokenId, actor_type: 'system' });
  // Одна транзакция: время строки журнала вызовов и записи аудита одно.
  const both = (
    await pools.root.query(
      `select c.created_on = a.created_on as same from hda_agent_tool_calls c join hdc_audit_log a on a.object_id = c.token_id::text and a.diff ->> 'tool' = c.tool where c.token_id = $1`,
      [main.tokenId],
    )
  ).rows;
  expect(both.map((r) => r.same)).toEqual([true, true]);
});

test('неверные аргументы: invalid_arguments без выполнения; журнал с хешем аргументов, без самих аргументов', async () => {
  const main = await seedAgentToken({ tools: ['list_known_problems'] });
  const a = client(main.value);
  const secret = 'Секретный-текст-аргумента';
  expect(errorOf(await a.callTool('list_known_problems', { status: secret }))).toEqual({ error: 'invalid_arguments' });
  expect(errorOf(await a.callTool('list_known_problems', { limit: 5 }))).toBeNull();
  const rows = await calls(main.tokenId);
  expect(rows.map((r) => r.status)).toEqual(['invalid', 'ok']);
  const digest = createHash('sha256').update(JSON.stringify({ limit: 5 })).digest('hex');
  expect(rows[1].args_digest).toBe(digest);
  const dump = JSON.stringify([(await pools.root.query(`select * from hda_agent_tool_calls`)).rows, (await pools.root.query(`select * from hdc_audit_log`)).rows, events]);
  expect(dump).not.toContain(secret);
  expect(events.filter((e) => e.event === 'mcp.call').map((e) => e.fields)).toEqual([
    expect.objectContaining({ tokenId: main.tokenId, tool: 'list_known_problems', status: 'invalid' }),
    expect.objectContaining({ tokenId: main.tokenId, tool: 'list_known_problems', status: 'ok', ms: expect.any(Number) }),
  ]);
});

test('61-й вызов за минуту и вызов сверх суточного предела дают rate_limited с временем ожидания', async () => {
  const main = await seedAgentToken({ tools: ['list_known_problems'] });
  const a = client(main.value);
  for (let i = 0; i < 60; i += 1) expect(errorOf(await a.callTool('list_known_problems')), String(i)).toBeNull();
  const over = errorOf(await a.callTool('list_known_problems'));
  expect(over).toMatchObject({ error: 'rate_limited', retry_after_sec: expect.any(Number) });
  expect((await calls(main.tokenId)).at(-1)).toMatchObject({ status: 'rate_limited' });

  const daily = await seedAgentToken({ tools: ['list_known_problems'] });
  await pools.root.query(`update hda_agent_tokens set daily_limit = 3 where token_id = $1`, [daily.tokenId]);
  const b = client(daily.value);
  for (let i = 0; i < 3; i += 1) expect(errorOf(await b.callTool('list_known_problems'))).toBeNull();
  expect(errorOf(await b.callTool('list_known_problems'))).toMatchObject({ error: 'rate_limited' });
});

test('31-я неудачная попытка токена за 10 минут с адреса даёт 429, другой адрес не затронут', async () => {
  const bad = client(`hub_at_${'B'.repeat(43)}`, '10.0.5.5');
  for (let i = 0; i < 30; i += 1) expect((await bad.rpc('ping')).status, String(i)).toBe(401);
  const blocked = await bad.rpc('ping');
  expect(blocked.status).toBe(429);
  expect(Number(blocked.headers.get('retry-after'))).toBeGreaterThan(0);
  expect((await client(null, '10.0.5.5').rpc('ping')).status).toBe(429);
  const main = await seedAgentToken();
  expect((await client(main.value, '10.0.5.6').rpc('ping')).status).toBe(200);
});

test('неверные токены с адреса не закрывают вход действующему агенту с того же адреса (находка M10)', async () => {
  const bad = client(`hub_at_${'C'.repeat(43)}`, '10.0.5.9');
  for (let i = 0; i < 31; i += 1) await bad.rpc('ping');
  expect((await bad.rpc('ping')).status).toBe(429);
  const main = await seedAgentToken();
  expect((await client(main.value, '10.0.5.9').rpc('ping')).status).toBe(200);
  // Отозванный токен считается неверным: тот же блок.
  const revoked = await seedAgentToken({ revoked: true });
  expect((await client(revoked.value, '10.0.5.9').rpc('ping')).status).toBe(429);
});

test('метод кроме POST: 405; тело больше 64 КБ: 413; заголовок версии протокола неизвестный: 400', async () => {
  const main = await seedAgentToken();
  const a = client(main.value);
  for (const method of ['GET', 'DELETE', 'PUT']) {
    const reply = await a.raw('', {}, method);
    expect(reply.status, method).toBe(405);
    expect(reply.headers.get('allow')).toBe('POST');
  }
  const big = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping', params: { pad: 'x'.repeat(70_000) } });
  expect((await a.raw(big)).status).toBe(413);
  expect((await a.raw(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }), { 'mcp-protocol-version': '1999-01-01' })).status).toBe(400);
  expect((await a.raw(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }), { 'mcp-protocol-version': '2025-06-18' })).status).toBe(200);
  // Старые ревизии без пакетов и SSE сервер не объявляет (находка M8).
  for (const old of ['2025-03-26', '2024-11-05'])
    expect((await a.raw(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }), { 'mcp-protocol-version': old })).status, old).toBe(400);
  // Чужой источник страницы (защита от подмены DNS по спецификации MCP): 403.
  expect((await a.raw(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }), { origin: 'https://evil.example' })).status).toBe(403);
});

test('last_used_at обновляется не чаще раза в минуту', async () => {
  const main = await seedAgentToken();
  const used = async () => (await pools.root.query(`select last_used_at from hda_agent_tokens where token_id = $1`, [main.tokenId])).rows[0].last_used_at as Date | null;
  const a = client(main.value);
  await a.ping();
  const first = await used();
  expect(first).not.toBeNull();
  await a.ping();
  expect((await used())!.getTime()).toBe(first!.getTime());
  await pools.root.query(`update hda_agent_tokens set last_used_at = now() - interval '2 minutes' where token_id = $1`, [main.tokenId]);
  const moved = await used();
  await a.ping();
  expect((await used())!.getTime()).toBeGreaterThan(moved!.getTime());
});

test('после отзыва токена следующий вызов отклонён сразу (строка приёмки M8b)', async () => {
  const main = await seedAgentToken({ tools: ['list_known_problems'] });
  const a = client(main.value);
  expect(errorOf(await a.callTool('list_known_problems'))).toBeNull();
  await pools.root.query(`update hda_agent_tokens set revoked_at = now() where token_id = $1`, [main.tokenId]);
  const after = await a.rpc('tools/call', { name: 'list_known_problems', arguments: {} });
  expect(after.status).toBe(401);
  expect((await calls(main.tokenId)).map((r) => r.status)).toEqual(['ok']);
});

test('вызовы вне перечня считает минутный предел: сверх 60 отказ rate_limited без записи аудита (находка I4)', async () => {
  const main = await seedAgentToken({ tools: ['list_known_problems'] });
  const a = client(main.value);
  for (let i = 0; i < 60; i += 1) expect(errorOf(await a.callTool('list_ideas')), String(i)).toEqual({ error: 'tool_not_allowed' });
  const audits = async () => Number((await pools.root.query(`select count(*) from hdc_audit_log where action = 'agent.tool_refused' and object_id = $1`, [main.tokenId])).rows[0].count);
  expect(await audits()).toBe(60);
  for (let i = 0; i < 5; i += 1) expect(errorOf(await a.callTool(i % 2 ? 'list_known_problems' : 'list_ideas')), String(i)).toMatchObject({ error: 'rate_limited' });
  expect(await audits()).toBe(60);
  // Сверх предела журнал вызовов получает одну строку rate_limited за окно, а не строку на каждый отказ.
  const rows = await calls(main.tokenId);
  expect(rows.filter((r) => r.status === 'refused')).toHaveLength(60);
  expect(rows.filter((r) => r.status === 'rate_limited')).toHaveLength(1);
});

test('методы протокола ограничены отдельным пределом на токен: 121-й за минуту даёт 429 (находка I4)', async () => {
  const main = await seedAgentToken({ tools: ['list_known_problems'] });
  const a = client(main.value);
  for (let i = 0; i < 120; i += 1) expect((await a.rpc(i % 2 ? 'ping' : 'tools/list')).status, String(i)).toBe(200);
  const over = await a.rpc('ping');
  expect(over.status).toBe(429);
  expect(Number(over.headers.get('retry-after'))).toBeGreaterThan(0);
  expect(over.body).toMatchObject({ jsonrpc: '2.0', error: { code: -32000 } });
  // Вызовы инструментов считает свой предел: протокол его не занимает.
  expect(errorOf(await a.callTool('list_known_problems'))).toBeNull();
  // Другой токен не затронут.
  const other = await seedAgentToken();
  expect((await client(other.value).rpc('ping')).status).toBe(200);
});

test('одновременные вызовы числом вдвое больше пула не ждут друг друга: вызов не держит два соединения (находка I3)', async () => {
  const f = await seedTwoOrgs();
  const main = await seedAgentToken({ tools: ['get_ticket', 'add_internal_note', 'assistant_metrics'] });
  setMcpInflightLimitForTests(1000);
  try {
    const a = client(main.value);
    const n = getAppPool().options.max * 2;
    const started = Date.now();
    const results = await Promise.all(
      Array.from({ length: n }, (_, i) =>
        i % 3 === 0
          ? a.callTool('get_ticket', { number: f.tickets.aOrg.number })
          : i % 3 === 1
            ? a.callTool('add_internal_note', { ticket_number: f.tickets.aOrg.number, body: `Заметка ${i}` })
            : a.callTool('assistant_metrics', { from: '2026-11-01', to: '2026-11-02' }),
      ),
    );
    expect(results.map(errorOf)).toEqual(results.map(() => null));
    expect(Date.now() - started).toBeLessThan(5000);
  } finally {
    setMcpInflightLimitForTests(null);
  }
});

test('предел одновременных вызовов процесса: сверх него 429 и ошибка JSON-RPC, без журнала (находка I3)', async () => {
  const main = await seedAgentToken({ tools: ['list_known_problems'] });
  setMcpInflightLimitForTests(1);
  const held = acquireMcpSlot();
  try {
    expect(held).not.toBeNull();
    const reply = await client(main.value).rpc('tools/call', { name: 'list_known_problems', arguments: {} });
    expect(reply.status).toBe(429);
    expect(Number(reply.headers.get('retry-after'))).toBeGreaterThan(0);
    expect(reply.body).toMatchObject({ jsonrpc: '2.0', error: { code: -32000, message: 'Too many requests' } });
    expect(await calls(main.tokenId)).toEqual([]);
    // Методы протокола предел вызовов не занимают.
    expect((await client(main.value).rpc('ping')).status).toBe(200);
  } finally {
    held?.();
    setMcpInflightLimitForTests(null);
  }
  expect(errorOf(await client(main.value).callTool('list_known_problems'))).toBeNull();
});
