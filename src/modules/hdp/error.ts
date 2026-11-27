// Модуль hdp, слой error: ошибки модуля (docs/naming.md, раздел 5; правило ошибок: решение 0022).
// Сервис возвращает код, а не текст: текст на языке пользователя подставляет страница из messages/*.json.

export const HDP_ERROR_CODES = [
  'forbidden',
  'invalid_input',
  'not_found',
  'rate_limited',
  // Признак показа без публичного названия и описания хотя бы на одном языке (решение 5).
  'public_text_required',
  // Публичный текст с находкой проверки: телефон, почта, ИНН, ссылка вне разрешённых доменов, название организации (решение 6).
  'text_findings',
  // Сигнатура уже у другой активной проблемы (решение 7).
  'signature_taken',
  // Закрытая проблема не меняется; переход статуса не разрешён.
  'problem_closed',
  // Обращение уже привязано к другой проблеме (решение 9).
  'already_linked',
  // Обращение закрыто, объединено или из "Неопознанных": привязка не делается (решения 8, 9).
  'ticket_closed',
  // Привязка к неактивной проблеме там, где нужна активная (правило, привязка по сигнатуре).
  'problem_inactive',
  // Массовое действие: больше 100 обращений (решение 10).
  'too_many',
] as const;
export type HdpErrorCode = (typeof HDP_ERROR_CODES)[number];

export class HdpError extends Error {
  readonly code: HdpErrorCode;
  readonly retryAfterSec: number | undefined;

  constructor(code: HdpErrorCode, opts: { retryAfterSec?: number } = {}) {
    super(`hdp: ${code}`);
    this.name = 'HdpError';
    this.code = code;
    this.retryAfterSec = opts.retryAfterSec;
  }
}

export function isHdpError(error: unknown): error is HdpError {
  return error instanceof HdpError;
}
