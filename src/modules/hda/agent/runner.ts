import 'server-only';
import { withActor } from '@/db/with-actor';
import { logEvent } from '@/lib/log';
import { writeAudit } from '@/modules/hdc/api';
import { HdaAgentError, type HdaAgentErrorCode, isHdaAgentError } from '../error';
import type { AgentCallStatus, AgentTool } from '../pref';
import { agentToolCalls } from '../schema';
import { AGENT_TOOL_DEFS } from './catalog';
import type { AgentAuth } from './entry';
import { consumeCallLimits } from './limits';
import type { McpToolResult } from './server';
import type { ObjectRefs } from './tool';
import { argsDigest, toolLabel } from './util';

// Вызов инструмента сервера MCP (веха M8b, задача 4; FR-AGT-02, 05, 09, 10; план M8b, решения 12-14, 30, 31).
// Порядок: перечень токена (до схемы аргументов), пределы, схема аргументов, выполнение в транзакции актора agent.
// Каждый вызов пишет строку журнала вызовов: прошедший проверки в транзакции инструмента от актора agent, отказ до неё
// система. Отказ вне перечня и каждый вызов инструмента записи пишут журнал аудита той же транзакцией. Аргументов и
// текста ответов нет ни в журналах, ни в журнале работы: только хеш аргументов, имя инструмента и номера объектов.

const SYSTEM = { type: 'system', job: 'mcp.call' } as const;
const REFS_MAX = 100;

function errorResult(code: HdaAgentErrorCode, retryAfterSec?: number | null): McpToolResult {
  const body = { error: code, ...(retryAfterSec ? { retry_after_sec: retryAfterSec } : {}) };
  return { content: [{ type: 'text', text: JSON.stringify(body) }], isError: true };
}

type CallEntry = { tool: string; status: AgentCallStatus; digest: string; refs?: ObjectRefs; startedAt: number };

function note(access: AgentAuth, entry: CallEntry): number {
  const ms = Math.max(0, Math.round(performance.now() - entry.startedAt));
  logEvent(entry.status === 'error' ? 'error' : 'info', 'mcp.call', { tokenId: access.actor.tokenId, tool: entry.tool, status: entry.status, ms });
  return ms;
}

/** Строка журнала вызовов от системы: отказ до транзакции инструмента или сбой. Отказ вне перечня с записью аудита. */
async function recordBySystem(access: AgentAuth, entry: CallEntry): Promise<void> {
  const ms = note(access, entry);
  await withActor({ ...SYSTEM, ip: access.actor.ip ?? null }, async (tx) => {
    await tx.insert(agentToolCalls).values({ tokenId: access.actor.tokenId, tool: entry.tool, argsDigest: entry.digest, status: entry.status, durationMs: ms });
    if (entry.status === 'refused')
      await writeAudit(tx, { action: 'agent.tool_refused', objectType: 'agent_token', objectId: access.actor.tokenId, diff: { tool: entry.tool }, ip: access.actor.ip ?? null });
  });
}

export async function runAgentTool(access: AgentAuth, name: string, args: Record<string, unknown>): Promise<McpToolResult> {
  const startedAt = performance.now();
  const tool = toolLabel(name);
  const digest = argsDigest(args);
  const def = (access.actor.tools as readonly string[]).includes(name) ? AGENT_TOOL_DEFS[name as AgentTool] : undefined;
  if (!def) {
    await recordBySystem(access, { tool, status: 'refused', digest, startedAt });
    return errorResult('tool_not_allowed');
  }
  const limit = await consumeCallLimits({ tokenId: access.actor.tokenId, dailyLimit: access.dailyLimit, isRun: access.isRun });
  if (!limit.allowed) {
    await recordBySystem(access, { tool, status: 'rate_limited', digest, startedAt });
    return errorResult('rate_limited', limit.retryAfterSec);
  }
  const parsed = def.input.safeParse(args);
  if (!parsed.success) {
    await recordBySystem(access, { tool, status: 'invalid', digest, startedAt });
    return errorResult('invalid_arguments');
  }

  try {
    return await withActor(access.actor, async (tx) => {
      let outcome: { result: unknown; objectRefs: ObjectRefs } | HdaAgentError;
      try {
        // Точка сохранения: ошибка инструмента откатывает его записи, строка журнала остаётся.
        outcome = await tx.transaction(async (inner) => {
          const ran = await def.run(inner, access.actor, parsed.data);
          const checked = def.output.safeParse(ran.result);
          if (!checked.success) throw new Error('Ответ инструмента не по схеме');
          return { result: checked.data, objectRefs: ran.objectRefs };
        });
      } catch (error) {
        if (!isHdaAgentError(error)) throw error;
        outcome = error;
      }
      const refs = outcome instanceof HdaAgentError ? [] : outcome.objectRefs.slice(0, REFS_MAX);
      const status: AgentCallStatus = outcome instanceof HdaAgentError ? (outcome.code === 'invalid_arguments' ? 'invalid' : 'error') : 'ok';
      const ms = note(access, { tool, status, digest, startedAt });
      await tx.insert(agentToolCalls).values({ tokenId: access.actor.tokenId, tool, argsDigest: digest, objectRefs: refs, status, durationMs: ms });
      if (outcome instanceof HdaAgentError) return errorResult(outcome.code, outcome.retryAfterSec);
      if (def.kind === 'write')
        await writeAudit(tx, { action: 'agent.tool_called', objectType: 'agent_token', objectId: access.actor.tokenId, diff: { tool, objects: refs }, ip: access.actor.ip ?? null });
      const structured = outcome.result as Record<string, unknown>;
      return { content: [{ type: 'text', text: JSON.stringify(structured) }], structuredContent: structured };
    });
  } catch (error) {
    // Сбой без подробностей наружу; в журнал работы только код ошибки базы, без текста запроса и значений.
    logEvent('error', 'mcp.tool_failed', { tokenId: access.actor.tokenId, tool, code: (error as { code?: unknown }).code ?? null });
    await recordBySystem(access, { tool, status: 'error', digest, startedAt }).catch(() => undefined);
    return errorResult('internal');
  }
}
