import { createHash } from 'node:crypto';
import * as z from 'zod';
import { CODE_KINDS, CODE_MAX_LINES } from '../pref';

// Модуль hda, знания из кода: вид отчёта о сканировании и правила отклонения (веха M8c, задача 2; ТЗ 7.22
// FR-CODE-01, 02, 05, 12; план M8c, решения 4, 5, 25). Чистые функции без базы.
//
// Схема строгая: лишнее поле (например, выражение для сопоставления) делает отчёт неверным. После схемы портал
// проверяет содержимое: поле текста больше 10 строк (фрагмент кода), шаблон с синтаксисом регулярного выражения,
// подстановки не по правилу. Нарушения называют правило и путь поля, без значения: отклонённый отчёт в портале не
// сохраняется, остаётся только строка истории с причинами.

/** Языки продукта, на которых приходят шаблоны сообщений (FR-CODE-02). */
export const CODE_TEMPLATE_LOCALES = ['ru', 'uz', 'en', 'kk', 'tr'] as const;

const MODULES_MAX = 500;
const ERRORS_MAX = 2000;
const PLACEHOLDERS_MAX = 10;
const LETTERS_MIN = 8;

const line = (max: number) => z.string().trim().min(1).max(max).regex(/^[^\r\n]*$/u);
const prose = (max: number) => z.string().trim().min(1).max(max);
const moduleCode = z.string().regex(/^[a-z0-9][a-z0-9_.-]{0,79}$/);
const names = z.partialRecord(z.enum(CODE_TEMPLATE_LOCALES), line(200)).refine((value) => Object.keys(value).length > 0);
/** Ключ записи (решение 25): слова через точку, до 120 знаков. */
export const codeEntryKey = z.string().max(120).regex(/^[a-z][a-z0-9_]*(\.[a-z0-9_]+){1,4}$/);
/** Путь к файлу относительно корня репозитория: без "..", без начальной косой черты и букв диска. */
const relativePath = z
  .string()
  .min(1)
  .max(300)
  .regex(/^(?![/\\])(?![A-Za-z]:)[A-Za-z0-9_./-]+$/)
  .refine((path) => !path.split('/').includes('..'));

const location = z.strictObject({
  object: z.string().min(1).max(200).regex(/^[A-Za-z0-9_.$#:-]+$/),
  path: relativePath,
  line: z.number().int().min(1).max(10_000_000).nullable().optional(),
});

const codeModule = z.strictObject({
  code: moduleCode,
  name: names,
  summary: prose(2000).optional(),
  dependsOn: z.array(moduleCode).max(50).optional(),
  screens: z.array(z.strictObject({ code: moduleCode, name: names })).max(200).optional(),
});

const codeError = z.strictObject({
  key: codeEntryKey,
  code: z
    .string()
    .regex(/^[A-Z]{2,5}-\d{1,6}$/)
    .optional(),
  messageTemplates: z.partialRecord(z.enum(CODE_TEMPLATE_LOCALES), line(500)).refine((value) => Object.keys(value).length > 0),
  module: moduleCode.optional(),
  raisedIn: z.array(location).max(10),
  conditions: prose(2000),
  userCause: prose(2000),
  whatToCheck: z.array(prose(300)).min(1).max(10),
  kind: z.enum(CODE_KINDS),
  confidence: z.number().min(0).max(1),
});

export const codeScanReport = z
  .strictObject({
    scanId: z.string().regex(/^[A-Za-z0-9._-]{1,40}$/),
    repository: z.string().regex(/^[a-z0-9._-]{1,80}$/),
    commit: z.string().regex(/^[0-9a-f]{7,64}$/),
    modules: z.array(codeModule).max(MODULES_MAX),
    errors: z.array(codeError).max(ERRORS_MAX),
    changes: z
      .strictObject({ added: z.array(codeEntryKey).max(ERRORS_MAX), changed: z.array(codeEntryKey).max(ERRORS_MAX), removed: z.array(codeEntryKey).max(ERRORS_MAX) })
      .optional(),
  })
  .refine((report) => new Set(report.errors.map((e) => e.key)).size === report.errors.length, { message: 'duplicate_key' })
  .refine((report) => new Set(report.modules.map((m) => m.code)).size === report.modules.length, { message: 'duplicate_module' });

export type CodeScanReport = z.infer<typeof codeScanReport>;
export type CodeReportError = CodeScanReport['errors'][number];
export type CodeReportModule = CodeScanReport['modules'][number];

export type CodeViolationRule = 'code_too_long' | 'regex' | 'bad_placeholder' | 'template_too_loose';
export type CodeViolation = { rule: CodeViolationRule; path: string };

/** Число строк текста: перевод строки в конце не считается. */
export function textLines(text: string): number {
  return text.replace(/(\r?\n)+$/u, '').split(/\r?\n/u).length;
}

/** Синтаксис регулярного выражения в шаблоне (FR-CODE-05): шаблон задаётся текстом, выражение строит портал. */
const REGEX_SYNTAX: readonly RegExp[] = [
  /\\/u, // экранирование и классы \d, \s, \w
  /\.[*+?]/u, // .* .+ .?
  /\(\?/u, // (?i) (?: (?=
  /[[\]]/u, // классы знаков
  /\|/u, // чередование
  /\^/u, // якорь начала
  /\$\s*$|\$\)/u, // якорь конца
  /\{[^{}]*,[^{}]*\}|\{\s*\d+\s*\}/u, // повторители {n,m} и {n}
  /[*+?]\s*\)/u, // повторитель перед закрывающей скобкой
];
const PLACEHOLDER = /\{([A-Za-z_][A-Za-z0-9_]{0,39})\}/gu;

/** Нарушения одного шаблона сообщения. */
export function templateViolations(template: string): CodeViolationRule[] {
  const out = new Set<CodeViolationRule>();
  if (REGEX_SYNTAX.some((re) => re.test(template))) out.add('regex');
  const placeholders = [...template.matchAll(PLACEHOLDER)];
  const rest = template.replace(PLACEHOLDER, '');
  if (!out.has('regex') && /[{}]/u.test(rest)) out.add('bad_placeholder');
  if (placeholders.length > PLACEHOLDERS_MAX) out.add('bad_placeholder');
  if ((rest.match(/\p{L}/gu)?.length ?? 0) < LETTERS_MIN) out.add('template_too_loose');
  return [...out];
}

/** Все строки значения с путями полей. */
function* strings(value: unknown, path: string): Generator<[string, string]> {
  if (typeof value === 'string') yield [path, value];
  else if (Array.isArray(value)) for (const [i, item] of value.entries()) yield* strings(item, path ? `${path}.${i}` : String(i));
  else if (value && typeof value === 'object') for (const [key, item] of Object.entries(value)) yield* strings(item, path ? `${path}.${key}` : key);
}

/**
 * Нарушения отчёта, прошедшего схему: поле больше 10 строк в любом месте (FR-CODE-12), шаблоны с выражениями и
 * неверными подстановками (FR-CODE-05). Пусто: отчёт принимается.
 */
export function codeReportViolations(report: CodeScanReport): CodeViolation[] {
  const out: CodeViolation[] = [];
  for (const [path, text] of strings(report, '')) if (textLines(text) > CODE_MAX_LINES) out.push({ rule: 'code_too_long', path });
  for (const [i, error] of report.errors.entries())
    for (const [locale, template] of Object.entries(error.messageTemplates))
      if (typeof template === 'string') for (const rule of templateViolations(template)) out.push({ rule, path: `errors.${i}.messageTemplates.${locale}` });
  return out;
}

/** JSON с ключами по алфавиту: отпечаток не зависит от порядка полей. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.keys(value)
      .filter((key) => (value as Record<string, unknown>)[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`)
      .join(',')}}`;
  return JSON.stringify(value);
}

/** Отпечаток содержимого от агента (решение 10): с ним сравнивается следующее сканирование. */
export function entryDigest(entry: CodeReportError | CodeReportModule): string {
  return createHash('sha256').update(canonical(entry)).digest('hex');
}
