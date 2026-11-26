import 'server-only';
import { parseAiEnv } from '@/env';
import { createAnthropicClient } from './anthropic';
import { StubAiClient } from './stub';
import type { AiClient } from './types';

// Модуль hda: выбор клиента модели по окружению фонового процесса (план M5, решения 3 и 4). Ключ читается здесь и
// только при первом вызове: портал этот файл не вызывает, вызовы модели делают задачи фонового процесса.
// Нет ключа: null, решения работают без AI (черновик из темы обращения, перевод пишет сотрудник).

let override: { client: AiClient | null } | null = null;
let cached: { client: AiClient | null } | undefined;

export function getAiClient(): AiClient | null {
  if (override) return override.client;
  if (!cached) {
    const env = parseAiEnv(process.env);
    cached = {
      client: env.mode === 'anthropic' ? createAnthropicClient({ apiKey: env.apiKey }) : env.mode === 'stub' ? new StubAiClient() : null,
    };
  }
  return cached.client;
}

/** Модели уровней из окружения фонового процесса (AI_MODEL_FAST, AI_MODEL_QUALITY): значения по умолчанию, настройка сильнее. */
export function aiEnvModels(): Partial<Record<'fast' | 'quality', string>> {
  if (override) return {};
  const env = parseAiEnv(process.env);
  return env.mode === 'anthropic' ? env.models : {};
}

/** Тесты подменяют клиента (null: модели нет). Вызов без аргумента возвращает выбор по окружению. */
export function setAiClientForTests(client?: AiClient | null): void {
  override = client === undefined ? null : { client };
  cached = undefined;
}

export type { AiClient, AiRequest, AiResult, AiUsage } from './types';
export { AiResponseError, AiUnavailableError } from './types';
