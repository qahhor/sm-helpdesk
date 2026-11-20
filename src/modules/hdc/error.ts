// Модуль hdc, слой error: ошибки модуля (docs/naming.md, раздел 5).
// Сервис возвращает код, а не текст: текст на языке пользователя подставляет страница из messages/*.json.

export const HDC_ERROR_CODES = ['forbidden', 'invalid_input'] as const;

export type HdcErrorCode = (typeof HDC_ERROR_CODES)[number];

export class HdcError extends Error {
  readonly code: HdcErrorCode;

  constructor(code: HdcErrorCode) {
    super(`hdc: ${code}`);
    this.name = 'HdcError';
    this.code = code;
  }
}

export function isHdcError(error: unknown): error is HdcError {
  return error instanceof HdcError;
}
