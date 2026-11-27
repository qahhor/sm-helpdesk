import * as z from 'zod';

// Разбор протокола MCP (веха M8b, задача 4; решение владельца 0110, решения 4 и 30 плана M8b). Свой обработчик
// JSON-RPC 2.0 без пакетов: initialize, notifications/initialized, tools/list, tools/call, ping. Без состояния: сессий
// и потоков SSE нет, на запрос один ответ JSON, на уведомление 202 без тела. Каждое сообщение проверяется схемой Zod.
// Чистый модуль: проверку токена, пределы и инструменты даёт McpHandler, который строит вход сервера (api/agent.ts).

/**
 * Ревизии спецификации MCP, которые сервер исполняет, новые первыми. Ревизии 2025-03-26 и 2024-11-05 не объявлены:
 * они требуют пакетов JSON-RPC и потока SSE, которых у сервера нет (независимая проверка M8b, находка M8). Клиенту
 * старой ревизии сервер предлагает свою последнюю.
 */
export const MCP_PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18'] as const;
export const MCP_LATEST_VERSION = MCP_PROTOCOL_VERSIONS[0];
export const MCP_SERVER_INFO = { name: 'smartup-hub', version: '1.0.0' } as const;

const SUPPORTED: ReadonlySet<string> = new Set(MCP_PROTOCOL_VERSIONS);

export function isSupportedVersion(version: string): boolean {
  return SUPPORTED.has(version);
}

/** Согласование версии по спецификации: поддерживаемую версию клиента сервер повторяет, иначе предлагает свою последнюю. */
export function negotiateVersion(requested: string): string {
  return SUPPORTED.has(requested) ? requested : MCP_LATEST_VERSION;
}

export const JSONRPC_ERROR = {
  parse: { code: -32700, message: 'Parse error' },
  invalidRequest: { code: -32600, message: 'Invalid Request' },
  methodNotFound: { code: -32601, message: 'Method not found' },
  invalidParams: { code: -32602, message: 'Invalid params' },
  internal: { code: -32603, message: 'Internal error' },
} as const;

export type McpToolListing = { name: string; title?: string; description: string; inputSchema: Record<string, unknown>; outputSchema?: Record<string, unknown> };
export type McpToolResult = { content: { type: 'text'; text: string }[]; structuredContent?: Record<string, unknown>; isError?: boolean };

/** Допуск сообщения: место занято (освободить после ответа) или отказ с ожиданием в секундах. */
export type McpAdmission = { release(): void } | { retryAfterSec: number };

/** Что сервер умеет за протоколом: перечень инструментов токена и их вызов. */
export interface McpHandler {
  listTools(): McpToolListing[];
  callTool(name: string, args: Record<string, unknown>): Promise<McpToolResult>;
  /** Пояснение для агента в ответе initialize. */
  instructions?: string;
  /**
   * Допуск каждого запроса и уведомления до разбора параметров (находки I3, I4): пределы методов протокола и
   * одновременных вызовов. Отказ: HTTP 429 с ошибкой JSON-RPC -32000, у уведомления без тела.
   */
  admit?(method: string): Promise<McpAdmission>;
}

/** Ответ для HTTP: код и тело (null у уведомления); при отказе по пределу время ожидания. */
export type McpReply = { status: number; body: Record<string, unknown> | null; retryAfterSec?: number };

const TOO_MANY = { code: -32000, message: 'Too many requests' } as const;

const id = z.union([z.string().max(200), z.number().int().safe()]);
// Параметры проверяет схема метода: неверные параметры дают -32602, а не -32600.
const params = z.unknown().optional();
const request = z.object({ jsonrpc: z.literal('2.0'), id, method: z.string().min(1).max(200), params });
const notification = z.looseObject({ jsonrpc: z.literal('2.0'), method: z.string().min(1).max(200), params }).refine((value) => !('id' in value));
/** Ответ клиента на запрос сервера: сервер запросов не шлёт, такой ответ просто принимается. */
const clientResponse = z.looseObject({ jsonrpc: z.literal('2.0'), id: id.nullable() }).refine((value) => 'result' in value || 'error' in value);

const initializeParams = z.object({
  protocolVersion: z.string().max(40),
  capabilities: z.record(z.string(), z.unknown()),
  clientInfo: z.object({ name: z.string().max(200), version: z.string().max(100) }),
});
const listParams = z.object({ cursor: z.string().max(200).optional() }).optional();
const callParams = z.object({
  name: z.string().min(1).max(200),
  arguments: z.record(z.string(), z.unknown()).optional(),
});

type Id = z.infer<typeof id>;
const ok = (rid: Id, result: Record<string, unknown>): McpReply => ({ status: 200, body: { jsonrpc: '2.0', id: rid, result } });
const fail = (status: number, rid: Id | null, error: { code: number; message: string }): McpReply => ({ status, body: { jsonrpc: '2.0', id: rid, error: { ...error } } });

/** Разбирает тело запроса и отвечает по протоколу. Текст исключений обработчика наружу не выходит. */
export async function handleJsonRpc(text: string, handler: McpHandler): Promise<McpReply> {
  let message: unknown;
  try {
    message = JSON.parse(text);
  } catch {
    return fail(400, null, JSONRPC_ERROR.parse);
  }
  // Пакет запросов массивом спецификация с ревизии 2025-06-18 не допускает.
  if (Array.isArray(message) || typeof message !== 'object' || message === null) return fail(400, null, JSONRPC_ERROR.invalidRequest);

  const asRequest = request.safeParse(message);
  if (!asRequest.success) {
    const asNotification = notification.safeParse(message);
    if (asNotification.success) {
      const admission = handler.admit ? await handler.admit(asNotification.data.method) : null;
      if (admission && 'retryAfterSec' in admission) return { status: 429, body: null, retryAfterSec: admission.retryAfterSec };
      admission?.release();
      return { status: 202, body: null };
    }
    if (clientResponse.safeParse(message).success) return { status: 202, body: null };
    const raw = (message as { id?: unknown }).id;
    const known = id.safeParse(raw);
    return fail(400, known.success ? known.data : null, JSONRPC_ERROR.invalidRequest);
  }
  const { id: rid, method } = asRequest.data;
  const admission = handler.admit ? await handler.admit(method) : null;
  if (admission && 'retryAfterSec' in admission) return { ...fail(429, rid, TOO_MANY), retryAfterSec: admission.retryAfterSec };
  try {
    return await dispatch(rid, method, (message as { params?: unknown }).params, handler);
  } finally {
    admission?.release();
  }
}

async function dispatch(rid: Id, method: string, rawParams: unknown, handler: McpHandler): Promise<McpReply> {
  try {
    switch (method) {
      case 'initialize': {
        const parsed = initializeParams.safeParse(rawParams);
        if (!parsed.success) return fail(200, rid, JSONRPC_ERROR.invalidParams);
        return ok(rid, {
          protocolVersion: negotiateVersion(parsed.data.protocolVersion),
          capabilities: { tools: { listChanged: false } },
          serverInfo: { ...MCP_SERVER_INFO },
          ...(handler.instructions ? { instructions: handler.instructions } : {}),
        });
      }
      case 'ping':
        return ok(rid, {});
      case 'tools/list': {
        if (!listParams.safeParse(rawParams).success) return fail(200, rid, JSONRPC_ERROR.invalidParams);
        return ok(rid, { tools: handler.listTools() });
      }
      case 'tools/call': {
        const parsed = callParams.safeParse(rawParams);
        if (!parsed.success) return fail(200, rid, JSONRPC_ERROR.invalidParams);
        const result = await handler.callTool(parsed.data.name, parsed.data.arguments ?? {});
        return ok(rid, result);
      }
      default:
        return fail(200, rid, JSONRPC_ERROR.methodNotFound);
    }
  } catch {
    return fail(200, rid, JSONRPC_ERROR.internal);
  }
}
