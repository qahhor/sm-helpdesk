import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { processEvents } from '@/modules/hdc/api';
import { handleRuleEvent, newRuleRun } from '@/modules/hdw/api/engine';
import { pools } from './db';

// Помощники тестов автоматизации (план M8, задача 10). Встроенные уведомления портала стали предустановленными
// правилами: их создаёт миграция данных, а отправляет разбор событий в фоновой задаче automation.process.

const AUTOMATION = { type: 'system', job: 'automation.process' } as const;

/**
 * Возвращает предустановленные правила после общей очистки таблиц перед тестом: выполняет ту же команду INSERT, что
 * миграция drizzle/0067_hdw_builtin_rules.sql, под суперпользователем (в миграции на время вставки снимается
 * принуждение RLS). В настоящей базе эти строки есть всегда.
 */
export async function seedBuiltinRules(): Promise<void> {
  const sql = readFileSync(join(process.cwd(), 'drizzle', '0067_hdw_builtin_rules.sql'), 'utf8');
  const insert = /INSERT INTO hdw_rules[^;]+;/.exec(sql)?.[0];
  if (!insert) throw new Error('в миграции 0067 нет вставки предустановленных правил');
  await pools.root.query(insert);
}

/** Разбор очереди событий правилами, как это делает фоновая задача automation.process сразу после действия. */
export async function drainAutomation(now?: Date): Promise<{ processed: number; failed: number; applied: number }> {
  const run = newRuleRun(now ? { now: () => now } : {});
  const result = await processEvents(AUTOMATION, (tx, event) => handleRuleEvent(tx, event, run));
  return { ...result, applied: run.applied };
}
