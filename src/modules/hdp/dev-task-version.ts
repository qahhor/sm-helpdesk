import 'server-only';
import type { Tx } from '@/db/client';

// Модуль hdp: версия задачи разработки известной проблемы для итога закрытия (план M5c, задачи 5 и 8, решения 20,
// 25). Задачи разработки ведёт модуль hdw, который сам стоит над hdp (берёт у него привязку обращений и проверку
// проблем для правил), поэтому hdp не импортирует hdw: источник версии даёт hdw, соединяет сборка процесса
// (src/wiring.ts), как обработчик закрытия задачи идеи. Работает в транзакции вызывающего.

export type ProblemDevTaskVersion = (tx: Tx, problemId: string) => Promise<string | null>;

// Сборка Next.js может положить модуль в несколько частей: источник хранится в общем объекте процесса.
const shared = globalThis as typeof globalThis & { __hubProblemDevTaskVersion?: ProblemDevTaskVersion };

export function registerProblemDevTaskVersion(next: ProblemDevTaskVersion): void {
  shared.__hubProblemDevTaskVersion = next;
}

/** Версия задачи разработки проблемы или null. Источника нет (сборка процесса его потеряла): ошибка, а не тихий "Решено". */
export async function problemDevTaskVersionTx(tx: Tx, problemId: string): Promise<string | null> {
  const source = shared.__hubProblemDevTaskVersion;
  if (!source) throw new Error('hdp: источник версии задачи разработки не подключён (src/wiring.ts)');
  return source(tx, problemId);
}
