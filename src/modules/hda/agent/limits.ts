import 'server-only';
import { consumeRateLimit } from '@/modules/hdc/api';
import { RATE_RULES } from '@/modules/hdc/pref';

// Пределы вызовов сервера MCP (веха M8b, задача 4; FR-AGT-09, 14.5; план M8b, решение 12; независимая проверка M8b,
// находка I4, решение 0122). Счётчики общие для всех процессов web (hdc_rate_limits). На токен: 60 вызовов tools/call
// в минуту, считая и отклонённые вне перечня (минутный счётчик стоит до проверки перечня), суточный предел токена и у
// токена запуска 20 вызовов за срок (эти два только у инструментов из перечня); методы протокола отдельным пределом
// 120 в минуту. Отказ отдаётся агенту ошибкой инструмента rate_limited или ответом 429 с ожиданием.

export type CallLimitInput = { tokenId: string; dailyLimit: number; isRun: boolean };
export type LimitResult = { allowed: true } | { allowed: false; retryAfterSec: number };

async function consumeAll(checks: { key: string; rule: { limit: number; windowSec: number } }[], now: Date): Promise<LimitResult> {
  for (const check of checks) {
    const result = await consumeRateLimit(check.key, check.rule, now);
    if (!result.allowed) return { allowed: false, retryAfterSec: result.retryAfterSec };
  }
  return { allowed: true };
}

/** Минутный предел вызовов инструментов токена: каждый tools/call, и разрешённый, и вне перечня. */
export async function consumeMinuteLimit(tokenId: string, now: Date = new Date()): Promise<LimitResult> {
  return consumeAll([{ key: `agent:${tokenId}:m`, rule: RATE_RULES.agentCallsPerMinute }], now);
}

/** Суточный предел и предел токена запуска: только вызовы инструментов из перечня. */
export async function consumeCallLimits(input: CallLimitInput, now: Date = new Date()): Promise<LimitResult> {
  return consumeAll(
    [
      { key: `agent:${input.tokenId}:d`, rule: { limit: input.dailyLimit, windowSec: 86_400 } },
      ...(input.isRun ? [{ key: `agent:${input.tokenId}:run`, rule: RATE_RULES.agentRunTokenCalls }] : []),
    ],
    now,
  );
}

/** Предел методов протокола токена (initialize, tools/list, ping, уведомления и неизвестные методы). */
export async function consumeProtocolLimit(tokenId: string, now: Date = new Date()): Promise<LimitResult> {
  return consumeAll([{ key: `agent:${tokenId}:p`, rule: RATE_RULES.agentProtocolPerMinute }], now);
}

/** Писать ли строку rate_limited в журнал вызовов: первая за минуту на токен. */
export async function shouldLogRateLimited(tokenId: string, now: Date = new Date()): Promise<boolean> {
  return (await consumeRateLimit(`agent:${tokenId}:rl`, RATE_RULES.agentRateLimitedLog, now)).allowed;
}
