import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';
import { type EvalCase, type EvalQuery, formatReport, parseEvalSet, scoreEval } from '../eval/score';

// Подсчёт проверочного набора поиска (ТЗ 15.4; план M5, задача 11): доля правильного решения в первых трёх по языку,
// доля ложных показов среди запросов без решения, пороги 80% (ru), 65% (uz), 10% ложных. Разбор файлов набора.

const q = (id: string, locale: EvalQuery['locale'], expected: string | null): EvalQuery => ({ id, locale, query: 'запрос клиента', expected });
const c = (query: EvalQuery, shown: string[]): EvalCase => ({ query, shown });

test('доли по языкам и ложные показы на наборе с известным ответом', () => {
  const cases: EvalCase[] = [
    // Русский: 4 из 5 в первых трёх (80%, ровно порог).
    ...[1, 2, 3, 4].map((i) => c(q(`ru-${i}`, 'ru', 'a'), ['x', 'a'])),
    c(q('ru-5', 'ru', 'a'), ['x', 'y', 'z']),
    // Узбекский: 1 из 2 (50%, ниже 65%).
    c(q('uz-1', 'uz', 'b'), ['b']),
    c(q('uz-2', 'uz', 'b'), []),
    // Английский без порога: 1 из 1.
    c(q('en-1', 'en', 'c'), ['c']),
    // Без решения: 1 показ из 10 (10%, ровно порог).
    ...Array.from({ length: 9 }, (_, i) => c(q(`none-${i}`, 'ru', null), [])),
    c(q('none-9', 'uz', null), ['a']),
  ];
  const report = scoreEval(cases);
  expect(report.locales).toEqual([
    { locale: 'ru', total: 5, hits: 4, rate: 0.8, threshold: 0.8, passed: true },
    { locale: 'uz', total: 2, hits: 1, rate: 0.5, threshold: 0.65, passed: false },
    { locale: 'en', total: 1, hits: 1, rate: 1, threshold: null, passed: null },
  ]);
  expect(report.falseShow).toEqual({ total: 10, shown: 1, rate: 0.1, threshold: 0.1, passed: true });
  expect(report.misses).toEqual([
    { id: 'ru-5', expected: 'a', shown: ['x', 'y', 'z'] },
    { id: 'uz-2', expected: 'b', shown: [] },
  ]);
  expect(report.falseShows).toEqual([{ id: 'none-9', shown: ['a'] }]);
  expect(report.passed).toBe(false);
  const text = formatReport(report, { embedder: 'stub', solutions: 3, queries: cases.length }).join('\n');
  expect(text).toContain('ru: 4 из 5, 80.0%, порог 80% (порог пройден)');
  expect(text).toContain('uz: 1 из 2, 50.0%, порог 65% (НИЖЕ ПОРОГА)');
  expect(text).toContain('en: 1 из 1, 100.0%, порога нет');
  expect(text).toContain('Ложные показы: 1 из 10, 10.0%, порог не выше 10% (порог пройден)');
  expect(text).toContain('ru-5: ждали a, показано x, y, z (чужое)');
  expect(text).toContain('Итог: пороги 15.4 не пройдены.');
});

test('правильное решение четвёртым не считается; язык без запросов не проваливает набор', () => {
  const report = scoreEval([c(q('ru-1', 'ru', 'a'), ['x', 'y', 'z', 'a']), c(q('none', 'ru', null), [])]);
  expect(report.locales[0]).toMatchObject({ hits: 0, rate: 0, passed: false });
  expect(report.locales[1]).toMatchObject({ total: 0, rate: null, passed: null });
  expect(scoreEval([c(q('ru-1', 'ru', 'a'), ['a'])]).passed).toBe(true);
});

test('разбор набора: схема, повторы и ссылки на несуществующее решение отклоняются; файлы каталога проходят', () => {
  const sol = JSON.stringify([{ ref: 'a', locale: 'ru', title: 'Т', what: 'Ч', steps: ['Ш'] }]);
  expect(parseEvalSet(sol, JSON.stringify([{ id: 'q1', locale: 'ru', query: 'запрос', expected: 'a' }])).queries).toHaveLength(1);
  expect(() => parseEvalSet(sol, JSON.stringify([{ id: 'q1', locale: 'ru', query: 'запрос', expected: 'b' }]))).toThrow('решения b нет');
  expect(() => parseEvalSet(sol, JSON.stringify([q('q1', 'ru', null), q('q1', 'ru', null)]))).toThrow('q1 повторяется');
  expect(() => parseEvalSet(JSON.stringify([{ ref: 'a', locale: 'kk', title: 'Т', what: 'Ч', steps: ['Ш'] }]), '[]')).toThrow();
  const set = parseEvalSet(readFileSync('tests/eval/search/solutions.json', 'utf8'), readFileSync('tests/eval/search/queries.json', 'utf8'));
  expect(set.queries.length).toBeGreaterThanOrEqual(6);
  expect(set.queries.length).toBeLessThanOrEqual(9);
  for (const locale of ['ru', 'uz', 'en']) expect(set.queries.some((x) => x.locale === locale && x.expected === null), locale).toBe(true);
});
