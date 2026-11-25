// Подсчёт проверочного набора поиска (ТЗ 15.4; план M5, задача 11). Чистые функции без базы: разбор файлов набора,
// доли по языкам и сравнение с порогами. Прогон по базе в tests/eval/run.ts.

import * as z from 'zod';

export const EVAL_LOCALES = ['ru', 'uz', 'en'] as const;
export type EvalLocale = (typeof EVAL_LOCALES)[number];

/** Пороги раздела 15.4. У английского порога нет. */
export const THRESHOLDS = { hit: { ru: 0.8, uz: 0.65 } as Partial<Record<EvalLocale, number>>, falseShow: 0.1 };
/** Подсказка показывает не больше трёх решений (FR-SOL-08): "в первых трёх". */
export const TOP = 3;

const ref = z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/);
export const solutionSchema = z.strictObject({
  ref,
  locale: z.enum(EVAL_LOCALES),
  title: z.string().trim().min(1).max(200),
  what: z.string().trim().min(1).max(2000),
  steps: z.array(z.string().trim().min(1).max(2000)).min(1).max(20),
});
export const querySchema = z.strictObject({
  id: z.string().regex(/^[A-Za-z0-9._-]{1,40}$/),
  locale: z.enum(EVAL_LOCALES),
  query: z.string().trim().min(3).max(500),
  expected: ref.nullable(),
});
export type EvalSolution = z.infer<typeof solutionSchema>;
export type EvalQuery = z.infer<typeof querySchema>;

/** Разбор файлов набора: схема, уникальные имена, ссылки запросов на существующие решения. Ошибка называет запись. */
export function parseEvalSet(solutionsJson: string, queriesJson: string): { solutions: EvalSolution[]; queries: EvalQuery[] } {
  const solutions = z.array(solutionSchema).min(1).parse(JSON.parse(solutionsJson));
  const queries = z.array(querySchema).min(1).parse(JSON.parse(queriesJson));
  const refs = new Set<string>();
  for (const s of solutions) {
    if (refs.has(s.ref)) throw new Error(`Решение ${s.ref} повторяется`);
    refs.add(s.ref);
  }
  const ids = new Set<string>();
  for (const q of queries) {
    if (ids.has(q.id)) throw new Error(`Запрос ${q.id} повторяется`);
    ids.add(q.id);
    if (q.expected !== null && !refs.has(q.expected)) throw new Error(`Запрос ${q.id}: решения ${q.expected} нет в solutions.json`);
  }
  return { solutions, queries };
}

/** Итог одного запроса: какие решения (ref) показала подсказка, по порядку. */
export type EvalCase = { query: EvalQuery; shown: string[] };
export type LocaleScore = { locale: EvalLocale; total: number; hits: number; rate: number | null; threshold: number | null; passed: boolean | null };
export type EvalReport = {
  locales: LocaleScore[];
  falseShow: { total: number; shown: number; rate: number | null; threshold: number; passed: boolean | null };
  misses: { id: string; expected: string; shown: string[] }[];
  falseShows: { id: string; shown: string[] }[];
  passed: boolean;
};

const rate = (part: number, total: number) => (total === 0 ? null : part / total);

export function scoreEval(cases: readonly EvalCase[]): EvalReport {
  const locales = EVAL_LOCALES.map((locale): LocaleScore => {
    const withAnswer = cases.filter((c) => c.query.locale === locale && c.query.expected !== null);
    const hits = withAnswer.filter((c) => c.shown.slice(0, TOP).includes(c.query.expected as string)).length;
    const threshold = THRESHOLDS.hit[locale] ?? null;
    const value = rate(hits, withAnswer.length);
    return { locale, total: withAnswer.length, hits, rate: value, threshold, passed: threshold === null || value === null ? null : value >= threshold };
  });
  const noAnswer = cases.filter((c) => c.query.expected === null);
  const shown = noAnswer.filter((c) => c.shown.length > 0);
  const falseRate = rate(shown.length, noAnswer.length);
  const falseShow = { total: noAnswer.length, shown: shown.length, rate: falseRate, threshold: THRESHOLDS.falseShow, passed: falseRate === null ? null : falseRate <= THRESHOLDS.falseShow };
  const misses = cases
    .filter((c) => c.query.expected !== null && !c.shown.slice(0, TOP).includes(c.query.expected))
    .map((c) => ({ id: c.query.id, expected: c.query.expected as string, shown: c.shown }));
  return {
    locales,
    falseShow,
    misses,
    falseShows: shown.map((c) => ({ id: c.query.id, shown: c.shown })),
    passed: locales.every((l) => l.passed !== false) && falseShow.passed !== false,
  };
}

const percent = (value: number | null) => (value === null ? 'нет запросов' : `${(value * 100).toFixed(1)}%`);
const mark = (passed: boolean | null) => (passed === null ? '' : passed ? ' (порог пройден)' : ' (НИЖЕ ПОРОГА)');

/** Отчёт строками для консоли. */
export function formatReport(report: EvalReport, meta: { embedder: string; solutions: number; queries: number }): string[] {
  const lines = [`Набор: решений ${meta.solutions}, запросов ${meta.queries}. Векторы: ${meta.embedder}.`, ''];
  lines.push('Правильное решение в первых трёх:');
  for (const l of report.locales)
    lines.push(`  ${l.locale}: ${l.hits} из ${l.total}, ${percent(l.rate)}${l.threshold === null ? ', порога нет' : `, порог ${Math.round(l.threshold * 100)}%`}${mark(l.passed)}`);
  const f = report.falseShow;
  lines.push(`Ложные показы: ${f.shown} из ${f.total}, ${percent(f.rate)}, порог не выше ${Math.round(f.threshold * 100)}%${mark(f.passed)}`);
  if (report.misses.length > 0) {
    lines.push('', 'Промахи:');
    for (const m of report.misses) lines.push(`  ${m.id}: ждали ${m.expected}, показано ${m.shown.length > 0 ? `${m.shown.join(', ')} (чужое)` : 'ничего'}`);
  }
  if (report.falseShows.length > 0) {
    lines.push('', 'Ложные показы:');
    for (const s of report.falseShows) lines.push(`  ${s.id}: показано ${s.shown.join(', ')}`);
  }
  lines.push('', report.passed ? 'Итог: пороги 15.4 пройдены.' : 'Итог: пороги 15.4 не пройдены.');
  return lines;
}
