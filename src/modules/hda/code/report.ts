import { createHash } from 'node:crypto';
import * as z from 'zod';
import { stripInvisible } from '@/modules/hdc/pref';
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
/** Шаблон не слишком общий (независимая проверка M8c, находка M5; решение 0134): буквы и слова вне подстановок. */
const LETTERS_MIN = 15;
const WORDS_MIN = 2;
/** Не больше одной подстановки на столько букв вне подстановок. */
const LETTERS_PER_PLACEHOLDER = 5;
/** Предел строки текста (находка I1): длинная строка без переводов строк вмещает свёрнутый код. */
export const CODE_LINE_MAX = 300;

const line = (max: number) => z.string().trim().min(1).max(max).regex(/^[^\r\n]*$/u);
const prose = (max: number) => z.string().trim().min(1).max(max);
const moduleCode = z.string().regex(/^[a-z0-9][a-z0-9_.-]{0,79}$/);
/** Текст по языкам продукта: строгий объект, хотя бы один язык. */
const byLocale = (max: number) =>
  z
    .strictObject(Object.fromEntries(CODE_TEMPLATE_LOCALES.map((locale) => [locale, line(max).optional()])) as Record<(typeof CODE_TEMPLATE_LOCALES)[number], z.ZodOptional<ReturnType<typeof line>>>)
    .refine((value) => Object.values(value).some((text) => typeof text === 'string'));
const names = byLocale(200);
/** Ключ записи (решение 25): слова через точку, до 120 знаков. */
export const codeEntryKey = z.string().max(120).regex(/^[a-z][a-z0-9_]*(\.[a-z0-9_]+){1,4}$/);
/** Путь к файлу относительно корня репозитория: без "..", без начальной косой черты и букв диска. */
const relativePath = z
  .string()
  .min(1)
  .max(300)
  .regex(/^(?![/\\])(?![A-Za-z]:)[A-Za-z0-9_./-]+$/)
  .refine((path) => !path.split('/').includes('..'));

/** Место в коде ссылкой (FR-CODE-12): объект, относительный путь, строка. */
export const codeLocation = z.strictObject({
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
  messageTemplates: byLocale(500),
  module: moduleCode.optional(),
  raisedIn: z.array(codeLocation).max(10),
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

export type CodeViolationRule = 'code_too_long' | 'regex' | 'bad_placeholder' | 'template_too_loose' | 'control_char' | 'line_too_long' | 'code_like' | 'key_conflict';
export type CodeViolation = { rule: CodeViolationRule; path: string };

/** Любой перевод строки (находка I1): одиночный \r, \v, \f, U+0085, U+2028, U+2029 тоже делят строки. */
const LINE_BREAK = /\r\n|[\n\r\v\f\u0085\u2028\u2029]/u;
const TRAILING_BREAKS = /(?:\r\n|[\n\r\v\f\u0085\u2028\u2029])+$/u;

/** Число строк текста: перевод строки в конце не считается. */
export function textLines(text: string): number {
  return text.replace(TRAILING_BREAKS, '').split(LINE_BREAK).length;
}

/**
 * Управляющие, форматирующие знаки и разделители строк и абзацев (находка C2): невидимы на экране и ломают
 * выражение для сопоставления. В многострочном тексте допустим только \n (\r\n заранее приводится к \n).
 */
const CONTROL_CHAR = /(?!\n)[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;

/**
 * Признаки исходного кода в тексте (находка I1): присваивание PL/SQL, блок begin ... end;, запрос select ... from ...
 * where, три точки с запятой в строке, длинный знак без пробелов и вставка base64. Эвристика: короткий фрагмент
 * обычными словами её проходит, остаток риска записан в решении 0134.
 */
const CODE_LIKE: readonly RegExp[] = [
  /:=/u,
  /\bbegin\b[\s\S]*\bend(?:\s+(?:if|loop|case))?\s*;/iu,
  /\bselect\b[^;]{0,300}?\bfrom\s+[A-Za-z_][\w$#.]*\s+(?:where|join|group\s+by|order\s+by)\b/iu,
  /[A-Za-z0-9+/]{100,}/u,
  /\S{81,}/u,
];

/** Текст похож на код: правило code_like. */
export function looksLikeCode(text: string): boolean {
  if (CODE_LIKE.some((re) => re.test(text))) return true;
  return text.split(LINE_BREAK).some((line) => (line.match(/;/gu)?.length ?? 0) >= 3);
}

/** Windows-перевод строки как \n: формы браузера и агенты присылают \r\n. */
const unifyBreaks = (text: string) => text.replace(/\r\n/gu, '\n');

/** Текст для хранения: переводы строк \n, без невидимых знаков (находка I1). Вызывается после проверки. */
export function normalizeCodeText(text: string): string {
  return stripInvisible(unifyBreaks(text));
}

/**
 * Нарушения текста вывода (условия, причина, "что проверить", описание модуля, поля ответа анализа): управляющие
 * знаки, больше 10 строк, строка длиннее 300 знаков, похоже на код.
 */
export function textViolations(text: string): CodeViolationRule[] {
  const out: CodeViolationRule[] = [];
  const unified = unifyBreaks(text);
  if (CONTROL_CHAR.test(unified)) out.push('control_char');
  if (textLines(unified) > CODE_MAX_LINES) out.push('code_too_long');
  if (unified.split(LINE_BREAK).some((line) => line.length > CODE_LINE_MAX)) out.push('line_too_long');
  if (looksLikeCode(unified)) out.push('code_like');
  return out;
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
  // Шаблон одной строкой: ни одного управляющего знака, и \n тоже (находка C2).
  if (/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(template)) out.add('control_char');
  if (REGEX_SYNTAX.some((re) => re.test(template))) out.add('regex');
  if (looksLikeCode(template)) out.add('code_like');
  const placeholders = [...template.matchAll(PLACEHOLDER)];
  const rest = template.replace(PLACEHOLDER, ' ');
  if (!out.has('regex') && /[{}]/u.test(rest)) out.add('bad_placeholder');
  if (placeholders.length > PLACEHOLDERS_MAX) out.add('bad_placeholder');
  const letters = rest.match(/\p{L}/gu)?.length ?? 0;
  const words = rest.match(/\p{L}{2,}/gu)?.length ?? 0;
  if (letters < LETTERS_MIN || words < WORDS_MIN || placeholders.length * LETTERS_PER_PLACEHOLDER > letters) out.add('template_too_loose');
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
  const add = (rules: readonly CodeViolationRule[], path: string) => {
    for (const rule of rules) if (!out.some((v) => v.rule === rule && v.path === path)) out.push({ rule, path });
  };
  // Любая строка отчёта: управляющие знаки и 10 строк (FR-CODE-12, находки C2, I1).
  for (const [path, text] of strings(report, '')) add(textViolations(text).filter((rule) => rule === 'control_char' || rule === 'code_too_long'), path);
  // Тексты выводов: ещё длина строки и похожесть на код.
  for (const [i, error] of report.errors.entries()) {
    for (const [field, text] of [['conditions', error.conditions], ['userCause', error.userCause], ...error.whatToCheck.map((item, j) => [`whatToCheck.${j}`, item] as const)] as const)
      add(textViolations(text), `errors.${i}.${field}`);
    for (const [locale, template] of Object.entries(error.messageTemplates))
      if (typeof template === 'string') add(templateViolations(template), `errors.${i}.messageTemplates.${locale}`);
  }
  for (const [i, module] of report.modules.entries()) if (module.summary !== undefined) add(textViolations(module.summary), `modules.${i}.summary`);
  return out;
}

/** Копия отчёта со строками для хранения: \r\n как \n, без невидимых знаков (находка I1). После проверки. */
export function normalizeCodeReport(report: CodeScanReport): CodeScanReport {
  const walk = (value: unknown): unknown =>
    typeof value === 'string'
      ? normalizeCodeText(value)
      : Array.isArray(value)
        ? value.map(walk)
        : value && typeof value === 'object'
          ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, walk(item)]))
          : value;
  return walk(report) as CodeScanReport;
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
