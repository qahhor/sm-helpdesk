import type { z } from 'zod';
import type { AiTier } from '../pref';

// Модуль hda: интерфейс клиента модели (ТЗ 11.11; план M5, задача 5, решение 4). Один вызов: системный текст,
// данные и схема ответа. У модели нет инструментов и доступа к базе: она получает текст и возвращает текст, который
// код разбирает как JSON и проверяет схемой Zod. Реализации: Anthropic (anthropic.ts) и заглушка (stub.ts).

export type AiUsage = { inputTokens: number; outputTokens: number };

export type AiRequest<T> = {
  tier: AiTier;
  /** Правила для модели. Текст пользователей сюда не попадает никогда. */
  system: string;
  /** Данные: уже очищенный текст из перечня 14.3, внутри тегов данных. */
  data: string;
  schema: z.ZodType<T>;
  maxTokens: number;
};

export type AiResult<T> = { value: T; model: string; usage: AiUsage };

export interface AiClient {
  complete<T>(request: AiRequest<T>): Promise<AiResult<T>>;
}

/**
 * Ответа нет: сеть, срок, отказ адреса, ошибка API. code: timeout, blocked_address, unreachable, http_<код>.
 * Текста ответа в ошибке нет.
 */
export class AiUnavailableError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(`Модель недоступна: ${code}`);
    this.name = 'AiUnavailableError';
    this.code = code;
  }
}

/**
 * Ответ пришёл, но не годится: не JSON, обрезан пределом токенов, не прошёл схему. Токены уже потрачены: они
 * пишутся в журнал вызовов. Текста ответа в ошибке нет.
 */
export class AiResponseError extends Error {
  readonly code: string;
  readonly model: string;
  readonly usage: AiUsage;

  constructor(code: string, model: string, usage: AiUsage) {
    super(`Ответ модели не принят: ${code}`);
    this.name = 'AiResponseError';
    this.code = code;
    this.model = model;
    this.usage = usage;
  }
}
