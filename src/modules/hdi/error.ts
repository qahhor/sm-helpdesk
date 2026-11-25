// Модуль hdi, слой error: ошибки модуля (docs/naming.md, раздел 5; правило ошибок: решение 0022).
// Сервис возвращает код, а не текст: текст на языке пользователя подставляет страница из messages/*.json.

export const HDI_ERROR_CODES = [
  'forbidden',
  'invalid_input',
  'not_found',
  'rate_limited',
  'stale_session',
  'file_not_allowed',
  'file_too_large',
  'too_many_files',
  // Идея уже не на модерации: правка и вложения закрыты (решение 5).
  'not_editable',
  // Переход статуса не из таблицы IDEA_TRANSITIONS (решение 19).
  'bad_transition',
  // Цель объединения на модерации, отклонена, объединена или сама идея (решение 6).
  'bad_merge_target',
  // Публикация с блокирующей находкой без отметки "Проверено" (решение 9).
  'findings_unchecked',
  // Голос вне голосования (решение 4).
  'voting_closed',
  // Комментарии закрыты: идея отклонена или объединена (ответ Smartup ещё и у идеи на модерации).
  'comments_closed',
] as const;
export type HdiErrorCode = (typeof HDI_ERROR_CODES)[number];

export class HdiError extends Error {
  readonly code: HdiErrorCode;
  readonly retryAfterSec: number | undefined;

  constructor(code: HdiErrorCode, opts: { retryAfterSec?: number } = {}) {
    super(`hdi: ${code}`);
    this.name = 'HdiError';
    this.code = code;
    this.retryAfterSec = opts.retryAfterSec;
  }
}

export function isHdiError(error: unknown): error is HdiError {
  return error instanceof HdiError;
}
