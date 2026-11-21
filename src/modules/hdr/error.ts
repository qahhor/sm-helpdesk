// Модуль hdr, слой error: ошибки модуля (docs/naming.md, раздел 5).
// Сервис возвращает код, а не текст: текст на языке пользователя подставляет страница (решение 0022).

export const HDR_ERROR_CODES = ['forbidden', 'invalid_input'] as const;

export type HdrErrorCode = (typeof HDR_ERROR_CODES)[number];

export class HdrError extends Error {
  readonly code: HdrErrorCode;

  constructor(code: HdrErrorCode) {
    super(`hdr: ${code}`);
    this.name = 'HdrError';
    this.code = code;
  }
}

export function isHdrError(error: unknown): error is HdrError {
  return error instanceof HdrError;
}
