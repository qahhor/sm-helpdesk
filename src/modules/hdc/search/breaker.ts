// Выключатель поиска (план W6, решение 14): после 5 сбоев за 30 секунд процесс 60 секунд не ходит в Typesense, а сразу
// ищет прежним путём PostgreSQL. В памяти процесса только время сбоев: это состояние здоровья, а не данные.

export const BREAKER_FAILURES = 5;
export const BREAKER_WINDOW_MS = 30_000;
export const BREAKER_OPEN_MS = 60_000;

export type Breaker = {
  isOpen(now?: number): boolean;
  failure(now?: number): void;
  success(): void;
  state(now?: number): { open: boolean; recentFailures: number; openUntil: number | null };
};

export function createBreaker(): Breaker {
  let failures: number[] = [];
  let openUntil = 0;
  const prune = (now: number) => {
    failures = failures.filter((at) => now - at < BREAKER_WINDOW_MS);
  };
  return {
    isOpen(now = Date.now()) {
      return now < openUntil;
    },
    failure(now = Date.now()) {
      prune(now);
      failures.push(now);
      if (failures.length >= BREAKER_FAILURES) {
        openUntil = now + BREAKER_OPEN_MS;
        failures = [];
      }
    },
    success() {
      failures = [];
    },
    state(now = Date.now()) {
      prune(now);
      return { open: now < openUntil, recentFailures: failures.length, openUntil: now < openUntil ? openUntil : null };
    },
  };
}
