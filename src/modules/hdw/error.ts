import type { RuleIssue } from './rule-schema';

// Модуль hdw, слой error: ошибки модуля (docs/naming.md, раздел 5; правило ошибок: решение 0022).
// Сервис возвращает код, а не текст: текст на языке пользователя подставляет страница из messages/*.json.

// builtin_rule: предустановленное правило нельзя удалить (решение 2 плана M8).
// not_builtin: "вернуть исходное" есть только у предустановленного правила.
// stale_session: правила меняет только свежий вход администратора (ТЗ 14.3).
// invalid_url: адрес вебхука не https, несёт учётную запись или ведёт не на внешний узел (FR-AUTO-10).
// endpoint_disabled: проверочная отправка на выключенный адрес. too_many: достигнут предел числа адресов или макросов.
// Передача в разработку (FR-DEV): already_linked: у обращения уже есть задача; task_closed: задача с таким номером
// закрыта; not_manual: статус задачи из API таск-менеджера сотрудник не меняет; task_not_found: в таск-менеджере нет
// задачи с таким номером; tracker_unavailable: таск-менеджер не ответил, обращение не изменено.
export const HDW_ERROR_CODES = [
  'forbidden',
  'stale_session',
  'invalid_input',
  'not_found',
  'builtin_rule',
  'not_builtin',
  'invalid_url',
  'endpoint_disabled',
  'too_many',
  'already_linked',
  'task_closed',
  'not_manual',
  'task_not_found',
  'tracker_unavailable',
] as const;
export type HdwErrorCode = (typeof HDW_ERROR_CODES)[number];

export class HdwError extends Error {
  readonly code: HdwErrorCode;
  /** Для invalid_input: какие поля правила не приняты и почему. */
  readonly issues: RuleIssue[];

  constructor(code: HdwErrorCode, issues: RuleIssue[] = []) {
    super(`hdw: ${code}`);
    this.name = 'HdwError';
    this.code = code;
    this.issues = issues;
  }
}

export function isHdwError(error: unknown): error is HdwError {
  return error instanceof HdwError;
}
