// Модуль hda, слой error: ошибки модуля (docs/naming.md, раздел 5; правило ошибок: решение 0022).

export const HDA_ERROR_CODES = ['forbidden', 'invalid_input', 'stale_session', 'not_found'] as const;
export type HdaErrorCode = (typeof HDA_ERROR_CODES)[number];

export class HdaError extends Error {
  readonly code: HdaErrorCode;

  constructor(code: HdaErrorCode) {
    super(`hda: ${code}`);
    this.name = 'HdaError';
    this.code = code;
  }
}

export function isHdaError(error: unknown): error is HdaError {
  return error instanceof HdaError;
}
