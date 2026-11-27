import 'server-only';
import { getEnv } from '@/env';

// Предел одновременных вызовов инструментов сервера MCP в процессе (независимая проверка M8b, находка I3). Вызов
// инструмента занимает соединение пула базы; без предела поток вызовов агента забрал бы весь пул у портала. Предел
// MCP_MAX_INFLIGHT (по умолчанию 4, схема окружения); сверх него сервер отвечает 429, вызов не выполняется и в журнал
// вызовов не пишется. Счётчик в памяти процесса: у каждой копии портала свой.

export const MCP_INFLIGHT_DEFAULT = 4;

let override: number | null = null;
let inflight = 0;

/** Предел для тестов; null возвращает чтение окружения. */
export function setMcpInflightLimitForTests(limit: number | null): void {
  override = limit;
}

function limit(): number {
  return override ?? getEnv().MCP_MAX_INFLIGHT ?? MCP_INFLIGHT_DEFAULT;
}

/** Занять место вызова: функция освобождения или null, если процесс уже выполняет предельное число вызовов. */
export function acquireMcpSlot(): (() => void) | null {
  if (inflight >= limit()) return null;
  inflight += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    inflight -= 1;
  };
}
