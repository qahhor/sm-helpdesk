// Модуль hdk, слой error: ошибки модуля (docs/naming.md, раздел 5; правило ошибок: решение 0022).
// Сервис возвращает код, а не текст: текст на языке пользователя подставляет страница из messages/*.json.

export const HDK_ERROR_CODES = ['forbidden', 'invalid_input', 'not_found'] as const;
export type HdkErrorCode = (typeof HDK_ERROR_CODES)[number];

export class HdkError extends Error {
  readonly code: HdkErrorCode;

  constructor(code: HdkErrorCode) {
    super(`hdk: ${code}`);
    this.name = 'HdkError';
    this.code = code;
  }
}

export function isHdkError(error: unknown): error is HdkError {
  return error instanceof HdkError;
}
