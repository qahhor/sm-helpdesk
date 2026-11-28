import 'server-only';
import type { Tx } from '@/db/client';
import { withActor } from '@/db/with-actor';
import { logEvent } from '@/lib/log';
import { writeAudit } from '@/modules/hdc/api';
import { HdaAgentError, type HdaAgentErrorCode, isHdaAgentError } from '../error';
import type { AgentCallStatus, AgentTool } from '../pref';
import { agentToolCalls } from '../schema';
import { AGENT_TOOL_DEFS } from './catalog';
import type { AgentAuth } from './entry';
import { consumeCallLimits, consumeMinuteLimit, shouldLogRateLimited } from './limits';
import type { McpToolResult } from './server';
import { type AgentToolDef, type DeferredOutcome, isDeferred, type ObjectRefs } from './tool';
import { redactorFor } from './tools/common';
import { argsDigest, toolLabel } from './util';

// Вызов инструмента сервера MCP (веха M8b, задача 4; FR-AGT-02, 05, 09, 10; план M8b, решения 12-14, 30, 31;
// независимая проверка M8b, находки I3 и I4, решение 0122). Порядок: минутный предел токена (считает и вызовы вне
// перечня), перечень токена (до схемы аргументов), суточный предел и предел токена запуска, схема аргументов,
// подготовка системой, выполнение в транзакции актора agent. Каждый вызов пишет строку журнала вызовов: прошедший
// проверки от актора agent, отказ до неё система; сверх минутного предела одна строка rate_limited за минуту, без
// аудита. Отказ вне перечня и каждый вызов инструмента записи пишут журнал аудита той же транзакцией. Ответ чтения,
// которому нужно обезличивание, собирается после транзакции агента: система читает слова отдельной транзакцией, затем
// строка журнала пишется второй транзакцией агента. Транзакции не вкладываются: вызов держит одно соединение пула.
// Аргументов и текста ответов нет ни в журналах, ни в журнале работы: только хеш аргументов, имя и номера объектов.

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

/** Отказ по пределу: строка журнала первая за минуту, остальные только в журнал работы. */
async function rateLimited(access: AgentAuth, entry: CallEntry, retryAfterSec: number): Promise<McpToolResult> {
  if (await shouldLogRateLimited(access.actor.tokenId)) await recordBySystem(access, entry);
  else note(access, entry);
  return errorResult('rate_limited', retryAfterSec);
}

type Outcome = { result: unknown; objectRefs: ObjectRefs } | HdaAgentError;

/** Ответ инструмента по схеме выхода, иначе сбой. */
function checked(def: AgentToolDef, outcome: { result: unknown; objectRefs: ObjectRefs }): { result: unknown; objectRefs: ObjectRefs } {
  const parsed = def.output.safeParse(outcome.result);
  if (!parsed.success) throw new Error('Ответ инструмента не по схеме');
  return { result: parsed.data, objectRefs: outcome.objectRefs };
}

/** Строка журнала вызова и ответ агенту в транзакции агента. */
async function finishTx(tx: Tx, access: AgentAuth, def: AgentToolDef, outcome: Outcome, entry: Omit<CallEntry, 'status'>): Promise<McpToolResult> {
  const refs = outcome instanceof HdaAgentError ? [] : outcome.objectRefs.slice(0, REFS_MAX);
  const status: AgentCallStatus = outcome instanceof HdaAgentError ? (outcome.code === 'invalid_arguments' ? 'invalid' : 'error') : 'ok';
  const ms = note(access, { ...entry, status });
  await tx.insert(agentToolCalls).values({ tokenId: access.actor.tokenId, tool: entry.tool, argsDigest: entry.digest, objectRefs: refs, status, durationMs: ms });
  if (outcome instanceof HdaAgentError) return errorResult(outcome.code, outcome.retryAfterSec);
  if (def.kind === 'write')
    await writeAudit(tx, { action: 'agent.tool_called', objectType: 'agent_token', objectId: access.actor.tokenId, diff: { tool: entry.tool, objects: refs }, ip: access.actor.ip ?? null });
  const structured = outcome.result as Record<string, unknown>;
  return { content: [{ type: 'text', text: JSON.stringify(structured) }], structuredContent: structured };
}

export async function runAgentTool(access: AgentAuth, name: string, args: Record<string, unknown>): Promise<McpToolResult> {
  const startedAt = performance.now();
  const tool = toolLabel(name);
  const digest = argsDigest(args);
  const minute = await consumeMinuteLimit(access.actor.tokenId);
  if (!minute.allowed) return rateLimited(access, { tool, status: 'rate_limited', digest, startedAt }, minute.retryAfterSec);
  const def = (access.actor.tools as readonly string[]).includes(name) ? AGENT_TOOL_DEFS[name as AgentTool] : undefined;
  if (!def) {
    await recordBySystem(access, { tool, status: 'refused', digest, startedAt });
    return errorResult('tool_not_allowed');
  }
  const limit = await consumeCallLimits({ tokenId: access.actor.tokenId, dailyLimit: access.dailyLimit, isRun: access.isRun, dailyTokenId: access.dailyTokenId });
  if (!limit.allowed) return rateLimited(access, { tool, status: 'rate_limited', digest, startedAt }, limit.retryAfterSec);
  const parsed = def.input.safeParse(args);
  if (!parsed.success) {
    await recordBySystem(access, { tool, status: 'invalid', digest, startedAt });
    return errorResult('invalid_arguments');
  }

  try {
    let prepared: unknown;
    try {
      prepared = def.prepare ? await def.prepare(parsed.data) : undefined;
    } catch (error) {
      if (!isHdaAgentError(error)) throw error;
      await recordBySystem(access, { tool, status: error.code === 'invalid_arguments' ? 'invalid' : 'error', digest, startedAt });
      return errorResult(error.code, error.retryAfterSec);
    }
    const first = await withActor(access.actor, async (tx): Promise<{ reply: McpToolResult } | { deferred: DeferredOutcome<unknown> }> => {
      let outcome: Outcome | DeferredOutcome<unknown>;
      try {
        // Точка сохранения: ошибка инструмента откатывает его записи, строка журнала остаётся.
        outcome = await tx.transaction(async (inner) => {
          const ran = await def.run(inner, access.actor, parsed.data, prepared);
          if (isDeferred(ran)) {
            if (def.kind === 'write') throw new Error('Инструмент записи не откладывает ответ');
            return ran;
          }
          return checked(def, ran);
        });
      } catch (error) {
        if (!isHdaAgentError(error)) throw error;
        outcome = error;
      }
      if (!(outcome instanceof HdaAgentError) && isDeferred(outcome)) return { deferred: outcome };
      return { reply: await finishTx(tx, access, def, outcome, { tool, digest, startedAt }) };
    });
    if ('reply' in first) return first.reply;
    // Слова обезличивания система читает после транзакции агента, строка журнала пишется второй транзакцией.
    const redact = await redactorFor(first.deferred.redact);
    const outcome = checked(def, first.deferred.finish(redact));
    return await withActor(access.actor, (tx) => finishTx(tx, access, def, outcome, { tool, digest, startedAt }));
  } catch (error) {
    // Сбой без подробностей наружу; в журнал работы только код ошибки базы, без текста запроса и значений.
    logEvent('error', 'mcp.tool_failed', { tokenId: access.actor.tokenId, tool, code: (error as { code?: unknown }).code ?? null });
    await recordBySystem(access, { tool, status: 'error', digest, startedAt }).catch(() => undefined);
    return errorResult('internal');
  }
}
