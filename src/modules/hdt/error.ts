// Модуль hdt, слой error: ошибки модуля (docs/naming.md, раздел 5; правило ошибок: решение 0022).
// Сервис возвращает код, а не текст: текст на языке пользователя подставляет страница из messages/*.json.

export const HDT_ERROR_CODES = [
  'invalid_input',
  'not_found',
  'forbidden',
  'rate_limited',
  // Переход статуса запрещён таблицей раздела 7.2 или обращение уже изменилось (второе нажатие).
  'transition_refused',
  // Закрытое обращение нельзя открыть заново: срок вышел (FR-TK-12).
  'reopen_expired',
  'already_rated',
  // Больше 10 файлов в одном сообщении (FR-TK-13).
  'too_many_files',
  'file_not_allowed',
  'file_too_large',
  // Приложенного файла больше нет или его нельзя приложить: удалён обходом через сутки, не прошёл проверку,
  // уже прикреплён или загружен другим человеком (без различия причин).
  'file_unavailable',
  // Рабочее место (веха M3): обращение уже взял другой сотрудник; смена приоритета без причины (FR-SLA-03);
  // "Решено" без итога или "исправлено в версии" без номера (FR-AG-09).
  'already_taken',
  'reason_required',
  'resolution_required',
] as const;

export type HdtErrorCode = (typeof HDT_ERROR_CODES)[number];

export class HdtError extends Error {
  readonly code: HdtErrorCode;
  /** Через сколько секунд можно повторить (для rate_limited). */
  readonly retryAfterSec?: number;
  /** Кто уже взял обращение (для already_taken): идентификатор ставит ядро, имя подставляет слой api. */
  readonly holderId?: string;
  readonly holderName?: string;

  constructor(code: HdtErrorCode, opts: { retryAfterSec?: number; holderId?: string; holderName?: string } = {}) {
    super(`hdt: ${code}`);
    this.name = 'HdtError';
    this.code = code;
    this.retryAfterSec = opts.retryAfterSec;
    this.holderId = opts.holderId;
    this.holderName = opts.holderName;
  }
}

export function isHdtError(error: unknown): error is HdtError {
  return error instanceof HdtError;
}
