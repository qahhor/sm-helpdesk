// Модуль hdn, слой error: ошибки настроек почты и уведомлений (правило ошибок: решение 0022). Сервис возвращает
// код, текст на языке пользователя подставляет страница из messages/*.json.

export const HDN_ERROR_CODES = ['forbidden', 'invalid_input', 'not_found'] as const;

export type HdnErrorCode = (typeof HDN_ERROR_CODES)[number];

export class HdnError extends Error {
  readonly code: HdnErrorCode;

  constructor(code: HdnErrorCode) {
    super(`hdn: ${code}`);
    this.name = 'HdnError';
    this.code = code;
  }
}

export function isHdnError(error: unknown): error is HdnError {
  return error instanceof HdnError;
}
