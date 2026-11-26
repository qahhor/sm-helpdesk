import 'server-only';
import type { Tx } from '@/db/client';

// Модуль hdw, слой core: что делать с идеями закрытой задачи разработки (план M7, задача 9, решение 18). Модуль идей
// hdi стоит над hdw (берёт у него адаптер таск-менеджера и привязку), поэтому hdw не знает идей: модуль hdi даёт
// обработчик, а соединяет их сборка процесса (src/wiring.ts), как справочник контактов (аудит 23.11.2026, находка A1).
// Обработчик работает в транзакции смены статуса задачи: уведомления ставятся вместе со статусом или не ставятся вовсе.

export type ClosedDevTask = { ref: string; status: string; version: string | null };
export type IdeaDevTaskClosedHandler = (tx: Tx, ideaIds: readonly string[], task: ClosedDevTask) => Promise<number>;

// Как у справочника контактов (src/modules/hdc/contacts.ts): сборка Next.js может положить модуль в несколько частей,
// поэтому обработчик хранится в общем объекте процесса, а не в переменной модуля.
const shared = globalThis as typeof globalThis & { __hubIdeaDevTaskClosed?: IdeaDevTaskClosedHandler };

export function registerIdeaDevTaskClosed(next: IdeaDevTaskClosedHandler): void {
  shared.__hubIdeaDevTaskClosed = next;
}

/** Сколько уведомлений поставлено. Обработчика нет (сборка процесса его потеряла): ошибка, а не тихий пропуск. */
export async function ideaDevTaskClosedTx(tx: Tx, ideaIds: readonly string[], task: ClosedDevTask): Promise<number> {
  const handler = shared.__hubIdeaDevTaskClosed;
  if (!handler) throw new Error('hdw: обработчик закрытия задачи идеи не подключён (src/wiring.ts)');
  return handler(tx, ideaIds, task);
}
