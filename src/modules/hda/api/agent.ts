import 'server-only';
import { getEnv } from '@/env';
import { problemResponse, readLimited } from '@/modules/hdc/api';
import { normalizeCidr } from '../agent/auth';
import { agentToolListing } from '../agent/catalog';
import { type AgentServerSettings, authenticateAgent } from '../agent/entry';
import { acquireMcpSlot } from '../agent/inflight';
import { consumeProtocolLimit } from '../agent/limits';
import { runAgentTool } from '../agent/runner';
import { handleJsonRpc, isSupportedVersion, type McpHandler } from '../agent/server';
import { AGENT_NOTICE } from '../agent/util';

// Модуль hda, слой api: точка входа сервера MCP для AI-сотрудников, POST /api/mcp (ТЗ 13, 7.21 FR-AGT-01, 02, 05,
// 09, 10; план M8b, решения 4, 11-14, 29-31; решение владельца 0110). Обработчик без состояния: на каждый запрос
// проверка метода, источника, размера тела, адреса и токена, затем разбор JSON-RPC с перечнем инструментов только
// этого токена. Ответ одним JSON без кеша; сессий MCP и SSE нет. Без токенов сервер отвечает 401 и порталу не мешает.

/** Предел тела запроса (решение 4). */
const BODY_LIMIT = 64 * 1024;
/** Предел тела для токена с инструментом отчёта о сканировании кода: отчёт приходит одним вызовом (план M8c, решение 3). */
const SCAN_BODY_LIMIT = 2 * 1024 * 1024;
const NO_STORE = 'private, no-store';

let override: AgentServerSettings | null = null;

/** Общий список адресов сервера MCP для тестов. null возвращает чтение окружения. */
export function setAgentServerSettingsForTests(settings: AgentServerSettings | null): void {
  override = settings;
}

/** Настройки входа из окружения: MCP_ALLOWED_IPS через запятую, пусто значит "только список токена". */
export function agentServerSettings(): AgentServerSettings {
  if (override) return override;
  const raw = getEnv().MCP_ALLOWED_IPS;
  if (!raw) return { allowedIps: null };
  return { allowedIps: raw.split(',').flatMap((part) => normalizeCidr(part) ?? []) };
}

function hubOrigin(): string | null {
  try {
    return new URL(getEnv().HUB_URL).origin;
  } catch {
    return null;
  }
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(body === null ? null : JSON.stringify(body), {
    status,
    headers: { ...(body === null ? {} : { 'Content-Type': 'application/json' }), 'Cache-Control': NO_STORE, ...headers },
  });
}

export async function handleMcpRequest(request: Request, deps: { now?: () => Date } = {}): Promise<Response> {
  if (request.method !== 'POST') return problemResponse(405, 'method_not_allowed', { Allow: 'POST', 'Cache-Control': NO_STORE });
  // Защита от подмены DNS (спецификация MCP, транспорт HTTP): страница чужого сайта в браузере не ходит на сервер.
  const origin = request.headers.get('origin');
  if (origin !== null && origin !== hubOrigin()) return problemResponse(403, 'forbidden', { 'Cache-Control': NO_STORE });
  const version = request.headers.get('mcp-protocol-version');
  if (version !== null && !isSupportedVersion(version)) return problemResponse(400, 'unsupported_protocol_version', { 'Cache-Control': NO_STORE });
  const type = request.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase();
  if (type !== undefined && type !== 'application/json') return problemResponse(415, 'unsupported_media_type', { 'Cache-Control': NO_STORE });
  // Вход проверяется по заголовкам до чтения тела: большое тело без действующего токена не читается (веха M8c).
  const checked = await authenticateAgent(request, agentServerSettings(), deps.now?.() ?? new Date());
  if ('denied' in checked) {
    // Отказ по адресу отвечается так же, как неверный токен (долг M8b M9): держатель утёкшего токена не узнаёт по
    // ответу, что токен действует. Причину различают журнал вызовов и событие mcp.denied.
    if (checked.denied === 'rate_limited') return problemResponse(429, 'rate_limited', { 'Retry-After': String(checked.retryAfterSec ?? 60), 'Cache-Control': NO_STORE });
    return problemResponse(401, 'unauthorized', { 'WWW-Authenticate': 'Bearer', 'Cache-Control': NO_STORE });
  }
  const access = checked.auth;
  const text = await readLimited(request, access.actor.tools.includes('code_catalog_upsert') ? SCAN_BODY_LIMIT : BODY_LIMIT);
  if (text === null) return problemResponse(413, 'too_large', { 'Cache-Control': NO_STORE });
  const handler: McpHandler = {
    instructions: `Smartup Hub MCP server for internal AI staff. ${AGENT_NOTICE}`,
    listTools: () => agentToolListing(access.actor.tools),
    callTool: (name, args) => runAgentTool(access, name, args),
    // Вызов инструмента занимает место предела процесса (находка I3), остальные методы считает предел протокола (I4).
    admit: async (method) => {
      if (method === 'tools/call') {
        const release = acquireMcpSlot();
        return release ? { release } : { retryAfterSec: 1 };
      }
      const gate = await consumeProtocolLimit(access.actor.tokenId);
      return gate.allowed ? { release: () => undefined } : { retryAfterSec: gate.retryAfterSec };
    },
  };
  const reply = await handleJsonRpc(text, handler);
  return json(reply.status, reply.body, reply.retryAfterSec ? { 'Retry-After': String(reply.retryAfterSec) } : {});
}
