import { expect, test } from 'vitest';
import { AI_EVAL_DIR, runAiEval } from './ai-run';

// pnpm eval:ai (ТЗ 15.6, поправка 101; план M5b, задача 11): проверочный набор помощника и набор атак, отчёт по
// порогам. По умолчанию заглушка; EVAL_AI_MODE=real берёт настоящую модель (нужен ключ). Пороги, которые держит код
// (обязательные темы, человек, шаги дословно, атаки, 60 секунд), проверяются всегда; доли правильных решений и
// ответов вместо передачи имеют смысл только с настоящей моделью и набором 15.6.

test('проверочный набор AI-помощника и набор атак', async () => {
  const { report, lines } = await runAiEval({ mode: process.env.EVAL_AI_MODE === 'real' ? 'real' : 'stub', dir: process.env.EVAL_AI_DIR || AI_EVAL_DIR });
  console.log(lines.join('\n'));
  for (const t of report.thresholds) if (t.passed !== null) expect(t.passed, t.name).toBe(true);
}, 600_000);
