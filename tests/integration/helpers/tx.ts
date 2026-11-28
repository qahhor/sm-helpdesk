import { type NestedTx, setNestedTxHookForTests, setTxOpenHookForTests } from '@/db/with-actor';

// Счёт транзакций в тестах (проверка качества, Q2, Q3, Q11): сколько транзакций открыл вызов и не открыл ли он
// транзакцию внутри другой.

/** Место вызова вложенной транзакции: файл и функция исходника, без номеров строк. */
export function nestedSite(found: NestedTx): string {
  const frame = found.stack.split('\n').find((line) => line.includes('/src/') && !line.includes('/src/db/'));
  const match = frame ? /at (?:async )?(?:(\S+) \()?.*\/(src\/[^:)]+)/.exec(frame) : null;
  return `${found.outer}>${found.inner} ${match ? `${match[2]}#${match[1] ?? ''}` : 'tests'}`;
}

type NestedHook = (found: NestedTx) => void;
let baseHook: NestedHook | null = null;

/** Общий сборщик вложенных транзакций всего прогона (tests/integration/setup/each.ts): countTx возвращает его на место. */
export function setBaseNestedHook(hook: NestedHook | null): void {
  baseHook = hook;
  setNestedTxHookForTests(hook);
}

/** Выполняет fn и возвращает, сколько транзакций открыто на каждом пуле и какие из них вложенные. */
export async function countTx<T>(fn: () => Promise<T>): Promise<{ result: T; app: number; auth: number; nested: string[] }> {
  const count = { app: 0, auth: 0 };
  const nested: string[] = [];
  setTxOpenHookForTests((pool) => {
    count[pool] += 1;
  });
  setNestedTxHookForTests((found) => {
    nested.push(nestedSite(found));
    baseHook?.(found);
  });
  try {
    const result = await fn();
    return { result, ...count, nested };
  } finally {
    setTxOpenHookForTests(null);
    setNestedTxHookForTests(baseHook);
  }
}
