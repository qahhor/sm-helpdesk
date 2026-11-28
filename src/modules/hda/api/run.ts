import 'server-only';
import type { SystemActor } from '@/db/with-actor';
import { withActor } from '@/db/with-actor';
import { env } from '@/env';
import { logEvent } from '@/lib/log';
import { readSetting } from '@/modules/hdc/api';
import { aiEnvModels, getAiClient } from '../client';
import { STUB_MODEL } from '../client/stub';
import { type AiRequest, AiResponseError, AiUnavailableError } from '../client/types';
import { activeCutoffTx, callsTodayTx, firstLineCallsTodayTx, insertRunTx, monthSpendTx, type PriorRun, priorRunTx } from '../core/runs';
import { AI_DAILY_LIMIT_DEFAULT, AI_DAILY_LIMIT_MAX, AI_DAILY_LIMIT_SETTING, AI_USER_LIMIT_PURPOSES, AI_SETTINGS, type AiPurpose, modelForPurpose } from '../pref';
import { costUsd, echoesSystemPrompt, inputHash } from '../util';
import { aiConfig } from './config';

// Модуль hda, слой api: один вызов модели с учётом (план M5, задача 5, решения 2, 3, 13; план M5b, задача 1, решения 1,
// 2, 11, 12). Порядок:
//   1. нет клиента (нет ключа): unavailable, модель не вызывается, строки журнала нет;
//   2. пределы: месячный предел расходов на все цели (или отключение всех задачей ai.budget); у первой линии и разбора
//      отключение организации и суточные пределы на пользователя и организацию, у остальных целей суточный предел 300.
//      Исчерпан: limited, строка журнала без модели и токенов;
//   3. повтор того же входа в организации за 24 часа: repeated, модель не вызывается, вызывающий повторяет прошлый выбор;
//   4. вызов вне транзакции базы модели, выбранной по цели (настройка ai.models, окружение, значение по умолчанию),
//      затем строка журнала: модель из ответа, токены, стоимость по цене этой модели, время, итог, без текста.
// Ответ, в котором есть шесть слов подряд из системной подсказки, считается ответом не по правилам (prompt_echo).
// Сбой модели (нет ответа, ответ не прошёл схему, отказ) записывается и бросается дальше: вызывающий решает, что делать
// (задача повторяет вызов, первая линия передаёт обращение сотруднику). Отказ модели не ломает ни одной страницы.

export type LimitKind = 'budget' | 'cutoff' | 'user' | 'org' | 'daily';
export type AiRunOutcome<T> =
  | { status: 'ok'; value: T; runId: string; model: string }
  | { status: 'limited'; limit: LimitKind }
  | { status: 'unavailable' }
  | { status: 'repeated'; runId: string; prior: PriorRun };

export type RunInput<T> = Omit<AiRequest<T>, 'model'> & {
  purpose: AiPurpose;
  orgId: string | null;
  refId: string | null;
  ticketId?: string | null;
  /** Автор текста: предел на пользователя у первой линии и разбора. */
  userId?: string | null;
  /** Повтор не вызывает модель (решение 12): ищется по HMAC данных запроса в организации. */
  detectRepeat?: boolean;
  /** Что ещё, кроме данных, делает вход другим для повтора (первая линия: приоритет, независимая проверка M5b, I1). */
  repeatKey?: string;
};

/** Суточный предел вызовов из настройки администратора; нет настройки или она неверна: 300 (решение 13). */
export async function aiDailyLimit(): Promise<number> {
  const value = await readSetting(AI_DAILY_LIMIT_SETTING);
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= AI_DAILY_LIMIT_MAX ? value : AI_DAILY_LIMIT_DEFAULT;
}

/** Модель цели по настройке ai.models и окружению фонового процесса (решение 1). */
export async function aiModelFor(purpose: AiPurpose): Promise<string> {
  const setting = await readSetting(AI_SETTINGS.models);
  return modelForPurpose(purpose, setting && typeof setting === 'object' ? (setting as Record<string, unknown>) : {}, aiEnvModels());
}

/** Какой предел исчерпан для этого вызова; null: можно вызывать (решение 11). */
async function exhausted(system: SystemActor, input: { purpose: AiPurpose; orgId: string | null; userId: string | null }): Promise<LimitKind | null> {
  const config = await aiConfig();
  const firstLine = AI_USER_LIMIT_PURPOSES.includes(input.purpose);
  return withActor(system, async (tx) => {
    const cutoff = await activeCutoffTx(tx, input.orgId);
    if (cutoff === 'all' || (await monthSpendTx(tx)).total >= config.monthlyBudgetUsd) return 'budget';
    if (!firstLine) return (await callsTodayTx(tx)) >= (await aiDailyLimit()) ? 'daily' : null;
    if (cutoff === 'org') return 'cutoff';
    const used = await firstLineCallsTodayTx(tx, input);
    if (input.userId && used.user >= config.userDailyLimit) return 'user';
    if (input.orgId && used.org >= config.orgDailyLimit) return 'org';
    return null;
  });
}

/** Итог вызова для черновиков и переводов (M5): без повтора и подробностей предела. */
export type RunOutcome<T> = { status: 'ok'; value: T } | { status: 'limited' } | { status: 'unavailable' };

/** Вызов для целей M5 и M7: тот же учёт и пределы, итог в прежнем виде. */
export async function runAi<T>(system: SystemActor, input: Omit<RunInput<T>, 'detectRepeat'>): Promise<RunOutcome<T>> {
  const outcome = await callAi<T>(system, input);
  if (outcome.status === 'ok') return { status: 'ok', value: outcome.value };
  if (outcome.status === 'repeated') throw new Error('hda: повтор без detectRepeat');
  return outcome.status === 'limited' ? { status: 'limited' } : { status: 'unavailable' };
}

/** Вызов модели с учётом, пределами и повтором (план M5b, задача 1). */
export async function callAi<T>(system: SystemActor, input: RunInput<T>): Promise<AiRunOutcome<T>> {
  const client = getAiClient();
  if (!client) return { status: 'unavailable' };
  const base = { orgId: input.orgId, refId: input.refId, purpose: input.purpose, ticketId: input.ticketId ?? null, userId: input.userId ?? null };
  const none = { model: null, inputTokens: 0, outputTokens: 0, costUsd: 0, latencyMs: 0, errorCode: null };
  const limit = await exhausted(system, { purpose: input.purpose, orgId: input.orgId, userId: input.userId ?? null });
  if (limit) {
    await withActor(system, (tx) => insertRunTx(tx, { ...base, ...none, outcome: 'limited' }));
    logEvent('warn', 'ai.limited', { purpose: input.purpose, limit });
    return { status: 'limited', limit };
  }
  const hash = input.detectRepeat && input.orgId ? inputHash(input.repeatKey ? `${input.repeatKey}\n${input.data}` : input.data, env.ENCRYPTION_KEY) : null;
  if (hash && input.orgId) {
    const orgId = input.orgId;
    const repeated = await withActor(system, async (tx) => {
      const prior = await priorRunTx(tx, { orgId, purpose: input.purpose, inputHash: hash });
      return prior ? { prior, runId: await insertRunTx(tx, { ...base, ...none, outcome: 'repeated', inputHash: hash }) } : null;
    });
    if (repeated) return { status: 'repeated', ...repeated };
  }
  const model = await aiModelFor(input.purpose);
  // Заглушка считается по цене выбранной модели: учёт расходов проверяется и без ключа.
  const priced = (answered: string, usage: { inputTokens: number; outputTokens: number }) => costUsd(answered === STUB_MODEL ? model : answered, usage);
  const started = Date.now();
  try {
    const result = await client.complete({
      model,
      system: input.system,
      data: input.data,
      schema: input.schema,
      maxTokens: input.maxTokens,
      ...(input.structured ? { structured: true } : {}),
      ...(input.effort ? { effort: input.effort } : {}),
      ...(input.timeoutMs ? { timeoutMs: input.timeoutMs } : {}),
    });
    // Ответ, повторяющий системную подсказку, не принимается (волна 7, S-T): токены потрачены и записаны, как у
    // ответа не по схеме.
    if (echoesSystemPrompt(result.value, input.system)) throw new AiResponseError('prompt_echo', result.model, result.usage);
    const runId = await withActor(system, (tx) =>
      insertRunTx(tx, {
        ...base,
        model: result.model,
        ...result.usage,
        costUsd: priced(result.model, result.usage),
        latencyMs: Date.now() - started,
        outcome: 'ok',
        errorCode: null,
        inputHash: hash,
      }),
    );
    return { status: 'ok', value: result.value, runId, model: result.model };
  } catch (error) {
    const latencyMs = Date.now() - started;
    if (error instanceof AiResponseError)
      await withActor(system, (tx) =>
        insertRunTx(tx, { ...base, model: error.model, ...error.usage, costUsd: priced(error.model, error.usage), latencyMs, outcome: 'invalid_response', errorCode: error.code }),
      );
    else
      await withActor(system, (tx) =>
        insertRunTx(tx, { ...base, ...none, latencyMs, outcome: 'failed', errorCode: error instanceof AiUnavailableError ? error.code : 'unexpected' }),
      );
    logEvent('warn', 'ai.failed', { purpose: input.purpose, code: error instanceof AiResponseError || error instanceof AiUnavailableError ? error.code : 'unexpected' });
    throw error;
  }
}
