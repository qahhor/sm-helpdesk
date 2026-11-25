import 'server-only';
import type { SystemActor } from '@/db/with-actor';
import { withActor } from '@/db/with-actor';
import { logEvent } from '@/lib/log';
import { readSetting } from '@/modules/hdc/api';
import { getAiClient } from '../client';
import { type AiRequest, AiResponseError, AiUnavailableError } from '../client/types';
import { callsTodayTx, insertRunTx } from '../core/runs';
import { AI_DAILY_LIMIT_DEFAULT, AI_DAILY_LIMIT_MAX, AI_DAILY_LIMIT_SETTING, type AiPurpose } from '../pref';
import { costUsd } from '../util';

// Модуль hda, слой api: один вызов модели с учётом (план M5, задача 5, решения 2, 3, 13). Порядок:
//   1. нет клиента (нет ключа): unavailable, модель не вызывается, строки журнала нет;
//   2. суточный предел исчерпан: limited, строка журнала без модели и токенов;
//   3. вызов вне транзакции базы, затем строка журнала: модель, токены, стоимость, время, итог, без текста.
// Сбой модели (нет ответа, ответ не прошёл схему) записывается и бросается дальше: задача фонового процесса повторит
// вызов, страница показывает состояние. Отказ модели не ломает ни одну страницу.

export type RunOutcome<T> = { status: 'ok'; value: T } | { status: 'limited' } | { status: 'unavailable' };

export type RunInput<T> = AiRequest<T> & { purpose: AiPurpose; orgId: string | null; refId: string | null };

/** Суточный предел вызовов из настройки администратора; нет настройки или она неверна: 300 (решение 13). */
export async function aiDailyLimit(): Promise<number> {
  const value = await readSetting(AI_DAILY_LIMIT_SETTING);
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= AI_DAILY_LIMIT_MAX ? value : AI_DAILY_LIMIT_DEFAULT;
}

export async function runAi<T>(system: SystemActor, input: RunInput<T>): Promise<RunOutcome<T>> {
  const client = getAiClient();
  if (!client) return { status: 'unavailable' };
  const base = { orgId: input.orgId, refId: input.refId, purpose: input.purpose };
  const limit = await aiDailyLimit();
  const used = await withActor(system, (tx) => callsTodayTx(tx));
  if (used >= limit) {
    await withActor(system, (tx) =>
      insertRunTx(tx, { ...base, model: null, inputTokens: 0, outputTokens: 0, costUsd: 0, latencyMs: 0, outcome: 'limited', errorCode: null }),
    );
    logEvent('warn', 'ai.limited', { purpose: input.purpose, limit });
    return { status: 'limited' };
  }
  const started = Date.now();
  try {
    const result = await client.complete({ tier: input.tier, system: input.system, data: input.data, schema: input.schema, maxTokens: input.maxTokens });
    await withActor(system, (tx) =>
      insertRunTx(tx, {
        ...base,
        model: result.model,
        ...result.usage,
        costUsd: costUsd(input.tier, result.usage),
        latencyMs: Date.now() - started,
        outcome: 'ok',
        errorCode: null,
      }),
    );
    return { status: 'ok', value: result.value };
  } catch (error) {
    const latencyMs = Date.now() - started;
    if (error instanceof AiResponseError)
      await withActor(system, (tx) =>
        insertRunTx(tx, { ...base, model: error.model, ...error.usage, costUsd: costUsd(input.tier, error.usage), latencyMs, outcome: 'invalid_response', errorCode: error.code }),
      );
    else
      await withActor(system, (tx) =>
        insertRunTx(tx, {
          ...base,
          model: null,
          inputTokens: 0,
          outputTokens: 0,
          costUsd: 0,
          latencyMs,
          outcome: 'failed',
          errorCode: error instanceof AiUnavailableError ? error.code : 'unexpected',
        }),
      );
    logEvent('warn', 'ai.failed', { purpose: input.purpose, code: error instanceof AiResponseError || error instanceof AiUnavailableError ? error.code : 'unexpected' });
    throw error;
  }
}
