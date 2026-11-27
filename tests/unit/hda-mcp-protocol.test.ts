import { describe, expect, test } from 'vitest';
import { handleJsonRpc, MCP_LATEST_VERSION, MCP_PROTOCOL_VERSIONS, type McpHandler, negotiateVersion } from '@/modules/hda/agent/server';

// Свой разбор протокола MCP (веха M8b, задача 4; решение владельца 0110): JSON-RPC 2.0, initialize,
// notifications/initialized, tools/list, tools/call, ping; без состояния, ответы только JSON.

const calls: { name: string; args: unknown }[] = [];
const handler: McpHandler = {
  listTools: () => [{ name: 'list_ideas', description: 'Идеи', inputSchema: { type: 'object' } }],
  callTool: async (name, args) => {
    calls.push({ name, args });
    return { content: [{ type: 'text', text: '{}' }], structuredContent: {} };
  },
};
const send = (body: unknown) => handleJsonRpc(typeof body === 'string' ? body : JSON.stringify(body), handler);
const req = (method: string, params?: unknown, id: number | string = 1) => ({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) });
const init = (protocolVersion: unknown) => req('initialize', { protocolVersion, capabilities: {}, clientInfo: { name: 'c', version: '1' } });

describe('согласование версии', () => {
  test('поддерживаемая версия клиента возвращается как есть', () => {
    for (const version of MCP_PROTOCOL_VERSIONS) expect(negotiateVersion(version)).toBe(version);
  });
  test('неизвестная версия: последняя поддерживаемая сервером', () => {
    expect(negotiateVersion('2099-01-01')).toBe(MCP_LATEST_VERSION);
    expect(negotiateVersion('')).toBe(MCP_LATEST_VERSION);
  });
  test('объявлены только ревизии, которые сервер исполняет: без пакетов и без SSE старых ревизий', () => {
    expect([...MCP_PROTOCOL_VERSIONS]).toEqual(['2025-11-25', '2025-06-18']);
  });
  test('старые ревизии 2025-03-26 и 2024-11-05 (пакеты, SSE): сервер предлагает свою последнюю', async () => {
    for (const old of ['2025-03-26', '2024-11-05']) {
      expect(negotiateVersion(old)).toBe(MCP_LATEST_VERSION);
      expect((await send(init(old))).body, old).toMatchObject({ result: { protocolVersion: MCP_LATEST_VERSION } });
    }
  });
  test('initialize отвечает версией, возможностями инструментов и именем сервера', async () => {
    const reply = await send(init('2025-06-18'));
    expect(reply.status).toBe(200);
    expect(reply.body).toMatchObject({
      jsonrpc: '2.0',
      id: 1,
      result: { protocolVersion: '2025-06-18', capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'smartup-hub' } },
    });
    expect((await send(init('1999-01-01'))).body).toMatchObject({ result: { protocolVersion: MCP_LATEST_VERSION } });
  });
});

describe('ошибки JSON-RPC', () => {
  test('неразборчивый JSON: -32700, id null, HTTP 400', async () => {
    const reply = await send('{"jsonrpc": "2.0", "id": 1, "method": ');
    expect(reply.status).toBe(400);
    expect(reply.body).toEqual({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
  });
  test('неверный запрос и пакет массивом: -32600', async () => {
    for (const body of [{ id: 1, method: 'ping' }, { jsonrpc: '1.0', id: 1, method: 'ping' }, { jsonrpc: '2.0', id: 1 }, { jsonrpc: '2.0', id: null, method: 'ping' }, [req('ping')], 'null', '7']) {
      const reply = await send(body);
      expect(reply.status, JSON.stringify(body)).toBe(400);
      expect((reply.body as { error: { code: number } }).error.code, JSON.stringify(body)).toBe(-32600);
    }
  });
  test('неизвестный метод: -32601 с id запроса', async () => {
    const reply = await send(req('resources/list', undefined, 'x-1'));
    expect(reply.status).toBe(200);
    expect(reply.body).toEqual({ jsonrpc: '2.0', id: 'x-1', error: { code: -32601, message: 'Method not found' } });
  });
  test('неверные параметры: -32602, инструмент не вызывается', async () => {
    calls.length = 0;
    for (const body of [req('tools/call', { arguments: {} }), req('tools/call', { name: 7 }), req('tools/call', { name: 'x', arguments: [] }), req('initialize', {}), req('tools/call', 'x')]) {
      const reply = await send(body);
      expect((reply.body as { error: { code: number } }).error.code, JSON.stringify(body)).toBe(-32602);
    }
    expect(calls).toEqual([]);
  });
});

describe('методы', () => {
  test('ping отвечает пустым объектом', async () => {
    expect((await send(req('ping'))).body).toEqual({ jsonrpc: '2.0', id: 1, result: {} });
  });
  test('уведомление: 202 без тела; ответ клиента тоже', async () => {
    expect(await send({ jsonrpc: '2.0', method: 'notifications/initialized' })).toEqual({ status: 202, body: null });
    expect(await send({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 1 } })).toEqual({ status: 202, body: null });
    expect(await send({ jsonrpc: '2.0', id: 5, result: {} })).toEqual({ status: 202, body: null });
  });
  test('tools/list отдаёт перечень обработчика', async () => {
    expect((await send(req('tools/list'))).body).toEqual({ jsonrpc: '2.0', id: 1, result: { tools: [{ name: 'list_ideas', description: 'Идеи', inputSchema: { type: 'object' } }] } });
  });
  test('tools/call передаёт имя и аргументы, без аргументов пустой объект', async () => {
    calls.length = 0;
    await send(req('tools/call', { name: 'list_ideas', arguments: { limit: 5 } }));
    await send(req('tools/call', { name: 'list_ideas' }));
    expect(calls).toEqual([
      { name: 'list_ideas', args: { limit: 5 } },
      { name: 'list_ideas', args: {} },
    ]);
  });
  test('сбой обработчика: -32603 без текста исключения', async () => {
    const broken: McpHandler = { ...handler, callTool: async () => Promise.reject(new Error('select * from secret')) };
    const reply = await handleJsonRpc(JSON.stringify(req('tools/call', { name: 'list_ideas' })), broken);
    expect(reply.body).toEqual({ jsonrpc: '2.0', id: 1, error: { code: -32603, message: 'Internal error' } });
  });
});
