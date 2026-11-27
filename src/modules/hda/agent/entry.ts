import 'server-only';
import { timingSafeEqual } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { type AgentActor, withActor } from '@/db/with-actor';
import { logEvent } from '@/lib/log';
import { clientIp, consumeRateLimit, ipBucket, peekRateLimit, rateKey } from '@/modules/hdc/api';
import { RATE_RULES } from '@/modules/hdc/pref';
import type { AgentTool } from '../pref';
import { agentTokens, agentToolCalls } from '../schema';
import { hashToken, ipAllowed, parseBearer } from './auth';

// Вход сервера MCP (веха M8b, задача 4; FR-AGT-02, T27; план M8b, решения 5, 11, 12, 29, 30). Каждый запрос заново:
// общий список адресов MCP_ALLOWED_IPS, предел неудачных проверок токена с адреса, токен по хешу в базе, действует ли
// он по функции базы app.agent_token_active() (не отозван, не истёк, учётная запись agent_bot активна, у токена запуска
// действует родитель), адрес из списка токена. Токен в памяти процесса не хранится: отзыв действует со следующего
// запроса. Причина отказа идёт только в журнал работы, агенту одинаковые 401 и 403.

const SYSTEM = { type: 'system', job: 'mcp.entry' } as const;

export type AgentAuth = { actor: AgentActor; dailyLimit: number; isRun: boolean };
export type AgentDenied = { denied: 'unauthorized' | 'forbidden_ip' | 'rate_limited'; retryAfterSec?: number };
export type AgentServerSettings = { allowedIps: readonly string[] | null };

const parent = alias(agentTokens, 'parent');

function sameHash(a: string, b: string): boolean {
  const left = Buffer.from(a, 'hex');
  const right = Buffer.from(b, 'hex');
  return left.length === right.length && timingSafeEqual(left, right);
}

/** Проверка запроса к серверу MCP. Актор строится только из строки токена в базе. */
export async function authenticateAgent(request: Request, settings: AgentServerSettings, now: Date = new Date()): Promise<{ auth: AgentAuth } | AgentDenied> {
  const ip = clientIp(request.headers);
  if (settings.allowedIps && !ipAllowed(ip, settings.allowedIps)) {
    logEvent('warn', 'mcp.denied', { reason: 'server_ip' });
    return { denied: 'forbidden_ip' };
  }
  const failKey = rateKey('mcp-token-fail:ip', ipBucket(ip));
  const gate = await peekRateLimit(failKey, RATE_RULES.mcpTokenFailuresPerIp, now);
  if (!gate.allowed) return { denied: 'rate_limited', retryAfterSec: gate.retryAfterSec };

  const unauthorized = async (reason: string): Promise<AgentDenied> => {
    await consumeRateLimit(failKey, RATE_RULES.mcpTokenFailuresPerIp, now);
    logEvent('warn', 'mcp.denied', { reason });
    return { denied: 'unauthorized' };
  };

  const value = parseBearer(request.headers.get('authorization'));
  if (!value) return unauthorized('no_token');
  const hash = hashToken(value);
  const [row] = await withActor(SYSTEM, (tx) =>
    tx
      .select({
        tokenId: agentTokens.tokenId,
        tokenHash: agentTokens.tokenHash,
        userId: agentTokens.staffUserId,
        tools: agentTokens.tools,
        allowedIps: agentTokens.allowedIps,
        ticketId: agentTokens.ticketId,
        dailyLimit: agentTokens.dailyLimit,
        lastUsedAt: agentTokens.lastUsedAt,
        parentDailyLimit: parent.dailyLimit,
      })
      .from(agentTokens)
      .leftJoin(parent, eq(parent.tokenId, agentTokens.parentTokenId))
      .where(eq(agentTokens.tokenHash, hash))
      .limit(1),
  );
  if (!row || !sameHash(row.tokenHash, hash)) return unauthorized('unknown_token');

  const actor: AgentActor = { type: 'agent', tokenId: row.tokenId, userId: row.userId, tools: row.tools as AgentTool[], ticketId: row.ticketId, ip };
  // Действует ли токен, решает база той же функцией, что закрывает данные агента в каждой транзакции инструмента.
  const active = await withActor(actor, async (tx) => {
    const result = await tx.execute<{ ok: boolean }>(sql`select app.agent_token_active() as ok`);
    return result.rows[0]?.ok === true;
  });
  if (!active) return unauthorized('inactive_token');

  if (!ipAllowed(ip, row.allowedIps)) {
    await withActor(SYSTEM, (tx) => tx.insert(agentToolCalls).values({ tokenId: row.tokenId, tool: 'connect', status: 'refused' }));
    logEvent('warn', 'mcp.denied', { tokenId: row.tokenId, reason: 'token_ip' });
    return { denied: 'forbidden_ip' };
  }

  // Время последнего вызова: не чаще раза в минуту, чтобы каждый вызов не писал строку токена.
  if (!row.lastUsedAt || now.getTime() - row.lastUsedAt.getTime() >= 60_000)
    await withActor(SYSTEM, (tx) =>
      tx
        .update(agentTokens)
        .set({ lastUsedAt: sql`now()` })
        .where(sql`${agentTokens.tokenId} = ${row.tokenId} and (${agentTokens.lastUsedAt} is null or ${agentTokens.lastUsedAt} < now() - interval '1 minute')`),
    );

  const isRun = row.ticketId !== null;
  return { auth: { actor, dailyLimit: isRun ? (row.parentDailyLimit ?? row.dailyLimit) : row.dailyLimit, isRun } };
}
