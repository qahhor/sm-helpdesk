import type { RuleIssue } from './rule-schema';

// Модуль hdw, слой error: ошибки модуля (docs/naming.md, раздел 5; правило ошибок: решение 0022).
// Сервис возвращает код, а не текст: текст на языке пользователя подставляет страница из messages/*.json.

// builtin_rule: предустановленное правило нельзя удалить (решение 2 плана M8).
// stale_session: правила меняет только свежий вход администратора (ТЗ 14.3).
export const HDW_ERROR_CODES = ['forbidden', 'stale_session', 'invalid_input', 'not_found', 'builtin_rule'] as const;
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
