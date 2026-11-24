// Модуль hdk, слой error: ошибки модуля (docs/naming.md, раздел 5; правило ошибок: решение 0022).
// Сервис возвращает код, а не текст: текст на языке пользователя подставляет страница из messages/*.json.

// conflict: черновик изменён в другой вкладке или другим сотрудником (автосохранение с проверкой версии строки, UX-W-04).
// not_ready: публикация не прошла панель готовности (UX-W-07), подробности в ответе функции, а не в коде.
export const HDK_ERROR_CODES = [
  'forbidden',
  'invalid_input',
  'not_found',
  'conflict',
  'stale_session',
  'rate_limited',
  'file_not_allowed',
  'file_too_large',
  'not_ready',
] as const;
export type HdkErrorCode = (typeof HDK_ERROR_CODES)[number];

export class HdkError extends Error {
  readonly code: HdkErrorCode;
  readonly retryAfterSec: number | undefined;

  constructor(code: HdkErrorCode, opts: { retryAfterSec?: number } = {}) {
    super(`hdk: ${code}`);
    this.name = 'HdkError';
    this.code = code;
    this.retryAfterSec = opts.retryAfterSec;
  }
}

export function isHdkError(error: unknown): error is HdkError {
  return error instanceof HdkError;
}
