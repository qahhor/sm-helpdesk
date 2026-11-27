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
  // Рассылка: нет принятого текста на языке получателей и не выбран текст оригинала (решение 17).
  'translation_required',
  // Рассылка уже подтверждена или нет получателей.
  'broadcast_closed',
  'no_recipients',
  // Черновик проблемы (веха M8b, решение 20): действие только с черновиком, привязка только после принятия.
  'not_draft',
  'not_accepted',
  'problem_draft',
] as const;
export type HdpErrorCode = (typeof HDP_ERROR_CODES)[number];

/** Находка проверки публичного текста для показа сотруднику: вид и найденный кусок. */
export type HdpFinding = { kind: string; text: string };

export class HdpError extends Error {
  readonly code: HdpErrorCode;
  readonly retryAfterSec: number | undefined;
  /** Находки проверки текста у отказа text_findings (решение 6). */
  readonly findings: HdpFinding[];

  constructor(code: HdpErrorCode, opts: { retryAfterSec?: number; findings?: HdpFinding[] } = {}) {
    super(`hdp: ${code}`);
    this.name = 'HdpError';
    this.code = code;
    this.retryAfterSec = opts.retryAfterSec;
    this.findings = opts.findings ?? [];
  }
}

export function isHdpError(error: unknown): error is HdpError {
  return error instanceof HdpError;
}
