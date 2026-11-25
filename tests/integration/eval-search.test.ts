import { afterEach, beforeEach, expect, test } from 'vitest';
import { setEmbedderForTests } from '@/modules/hdk/embeddings';
import { createStubEmbedder } from '@/modules/hdk/embeddings/stub';
import { runSearchEval } from '../eval/run';

// Дымовая проверка pnpm eval:search (план M5, задача 11; ТЗ 15.4): синтетический набор tests/eval/search проходит от
// начала до конца на заглушке векторов: решения публикуются и индексируются, запросы идут через функцию подсказки,
// отчёт считает доли по языкам и ложные показы. Качество поиска здесь не проверяется: набор придуманный.

beforeEach(() => setEmbedderForTests(createStubEmbedder()));
afterEach(() => setEmbedderForTests(null));

test('проверочный набор поиска проходит на заглушке векторов и даёт отчёт по трём языкам', async () => {
  const { report, lines, cases } = await runSearchEval();
  expect(cases).toHaveLength(9);
  expect(report.locales.map((l) => [l.locale, l.total])).toEqual([
    ['ru', 2],
    ['uz', 2],
    ['en', 2],
  ]);
  expect(report.falseShow.total).toBe(3);
  // Показанное в отчёте названо именами решений набора, а не чужими номерами.
  for (const c of cases) for (const ref of c.shown) expect(ref).toMatch(/^[a-z0-9-]+$/);
  const text = lines.join('\n');
  expect(text).toContain('Набор: решений 8, запросов 9. Векторы: stub.');
  expect(text).toContain('Ложные показы:');
  expect(text).toMatch(/Итог: пороги 15\.4 (не )?пройдены\./);
});
