import 'server-only';
import { consumeRateLimit } from '@/modules/hdc/api';
import { RATE_RULES } from '@/modules/hdc/pref';

// Пределы вызовов инструментов сервера MCP (веха M8b, задача 4; FR-AGT-09, 14.5; план M8b, решение 12). Счётчики
// общие для всех процессов web (hdc_rate_limits). На токен: 60 вызовов в минуту и суточный предел токена; на токен
// запуска по обращению ещё 20 вызовов за срок. Отказ отдаётся агенту ошибкой инструмента rate_limited с ожиданием.

export type CallLimitInput = { tokenId: string; dailyLimit: number; isRun: boolean };

/** Учитывает вызов во всех пределах токена. Первый закрытый предел даёт время ожидания в секундах. */
export async function consumeCallLimits(input: CallLimitInput, now: Date = new Date()): Promise<{ allowed: true } | { allowed: false; retryAfterSec: number }> {
  const checks = [
    { key: `agent:${input.tokenId}:m`, rule: RATE_RULES.agentCallsPerMinute },
    { key: `agent:${input.tokenId}:d`, rule: { limit: input.dailyLimit, windowSec: 86_400 } },
    ...(input.isRun ? [{ key: `agent:${input.tokenId}:run`, rule: RATE_RULES.agentRunTokenCalls }] : []),
  ];
  for (const check of checks) {
    const result = await consumeRateLimit(check.key, check.rule, now);
    if (!result.allowed) return { allowed: false, retryAfterSec: result.retryAfterSec };
  }
  return { allowed: true };
}
