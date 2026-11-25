import { expect, test } from 'vitest';
import { EVAL_DIR, runSearchEval } from './run';

// pnpm eval:search (ТЗ 15.4; план M5, задача 11): прогон проверочного набора и отчёт. По умолчанию отчёт без
// провала; EVAL_STRICT=1 проваливает прогон, если порог не пройден. Каталог набора: EVAL_SEARCH_DIR.

test('проверочный набор поиска: доля правильного решения в первых трёх и ложные показы', async () => {
  const { report, lines } = await runSearchEval(process.env.EVAL_SEARCH_DIR || EVAL_DIR);
  console.log(lines.join('\n'));
  if (process.env.EVAL_STRICT === '1') expect(report.passed, 'пороги 15.4').toBe(true);
});
