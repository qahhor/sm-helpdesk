// Тестовый клиент MCP (веха M8b, решение 32 плана, решение владельца 0110): маленький клиент JSON-RPC 2.0 без пакетов.
// Шлёт запросы функцией send: в интеграционных тестах это обработчик маршрута напрямую, в браузерных fetch по HTTP.

export type McpSend = (request: Request) => Promise<Response>;

export type McpClientOptions = {
  /** Значение токена AI-сотрудника. Без него запрос идёт без заголовка Authorization. */
  token?: string | null;
  /** Адрес запроса: ставится заголовком x-forwarded-for (так портал читает адрес без CLIENT_IP_HEADER). */
  ip?: string;
  /** Адрес сервера MCP. */
  url?: string;
  send: McpSend;
  /** Версия протокола для initialize. */
  protocolVersion?: string;
};

export type McpRpcReply = { status: number; headers: Headers; body: Record<string, unknown> | null };

export type McpToolCallResult = {
  isError?: boolean;
  content: { type: string; text: string }[];
  structuredContent?: Record<string, unknown>;
};

export function createMcpClient(options: McpClientOptions) {
  let id = 0;
  const url = options.url ?? 'http://localhost:3000/api/mcp';

  function headers(extra: Record<string, string> = {}): Record<string, string> {
    return {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
      ...(options.ip ? { 'x-forwarded-for': options.ip } : {}),
      ...extra,
    };
  }

  /** Любое тело как есть: для проверок ошибок разбора. */
  async function raw(body: string, extra: Record<string, string> = {}, method = 'POST'): Promise<McpRpcReply> {
    const response = await options.send(new Request(url, { method, headers: headers(extra), ...(method === 'POST' ? { body } : {}) }));
    const text = await response.text();
    let parsed: Record<string, unknown> | null = null;
    if (text) {
      try {
        parsed = JSON.parse(text) as Record<string, unknown>;
      } catch {
        parsed = { unparsed: text };
      }
    }
    return { status: response.status, headers: response.headers, body: parsed };
  }

  async function rpc(method: string, params?: unknown): Promise<McpRpcReply> {
    id += 1;
    return raw(JSON.stringify({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) }));
  }

  async function notify(method: string, params?: unknown): Promise<McpRpcReply> {
    return raw(JSON.stringify({ jsonrpc: '2.0', method, ...(params === undefined ? {} : { params }) }));
  }

  function result<T>(reply: McpRpcReply): T {
    if (reply.status !== 200 || !reply.body || !('result' in reply.body)) throw new Error(`MCP: нет результата (${reply.status} ${JSON.stringify(reply.body)})`);
    return reply.body.result as T;
  }

  return {
    raw,
    rpc,
    notify,
    async initialize(): Promise<{ protocolVersion: string; capabilities: Record<string, unknown>; serverInfo: { name: string; version: string } }> {
      const reply = await rpc('initialize', {
        protocolVersion: options.protocolVersion ?? '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'hub-test-client', version: '1.0.0' },
      });
      const value = result<{ protocolVersion: string; capabilities: Record<string, unknown>; serverInfo: { name: string; version: string } }>(reply);
      await notify('notifications/initialized');
      return value;
    },
    async listTools(): Promise<{ name: string; description: string; inputSchema: Record<string, unknown>; outputSchema?: Record<string, unknown> }[]> {
      return result<{ tools: { name: string; description: string; inputSchema: Record<string, unknown>; outputSchema?: Record<string, unknown> }[] }>(await rpc('tools/list')).tools;
    },
    async callTool(name: string, args: Record<string, unknown> = {}): Promise<McpToolCallResult> {
      return result<McpToolCallResult>(await rpc('tools/call', { name, arguments: args }));
    },
    async ping(): Promise<McpRpcReply> {
      return rpc('ping');
    },
  };
}

export type McpClient = ReturnType<typeof createMcpClient>;
