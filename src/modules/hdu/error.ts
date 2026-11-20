// Модуль hdu, слой error: ошибки модуля (docs/naming.md, раздел 5).
// Сервис возвращает код, а не текст: текст на языке пользователя подставляет страница из messages/*.json.

export const HDU_ERROR_CODES = [
  'forbidden',
  'not_found',
  'invalid_input',
  'invalid_credentials',
  'rate_limited',
  'code_invalid',
  'code_locked',
  'link_invalid',
  'email_taken',
  'already_member',
  'not_member',
  'stale_session',
  // Шаг входа устарел: между паролем и кодом прошло больше 10 минут. Нужно начать вход заново.
  'sign_in_expired',
  // Проверка "не робот" не пройдена (решение 0018).
  'bot_check',
] as const;

export type HduErrorCode = (typeof HDU_ERROR_CODES)[number];

export class HduError extends Error {
  readonly code: HduErrorCode;
  /** Через сколько секунд можно повторить (для rate_limited). */
  readonly retryAfterSec?: number;

  constructor(code: HduErrorCode, opts: { retryAfterSec?: number } = {}) {
    super(`hdu: ${code}`);
    this.name = 'HduError';
    this.code = code;
    this.retryAfterSec = opts.retryAfterSec;
  }
}

export function isHduError(error: unknown): error is HduError {
  return error instanceof HduError;
}
