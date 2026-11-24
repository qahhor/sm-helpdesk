import 'server-only';

// Размер пулов соединений с базой и бюджет соединений (аудит 23.11.2026, находка O6; решение 0039).
// У процесса портала два пула (роль приложения и роль входа) и соединения очереди задач. При двух копиях портала
// сумма не должна занимать больше 60% предела базы: остальное нужно миграциям, копиям и работам администратора.

/** Размер каждого из двух пулов процесса по умолчанию. Меняется переменной DB_POOL_MAX. */
export const DEFAULT_POOL_MAX = 10;
/** Соединения очереди задач: портал только ставит задачи, фоновый процесс их выполняет (hdc/jobs.ts). */
const QUEUE_SENDER = 2;
const QUEUE_WORKER = 5;

/** Размер пула из окружения или значение по умолчанию. */
export function poolMaxOf(value: number | undefined): number {
  return value ?? DEFAULT_POOL_MAX;
}

/** Сколько соединений с базой могут занять процессы портала при таком числе копий и размере пулов. */
export function connectionsFor(setup: { webReplicas: number; workers: number; poolMax: number }): number {
  return setup.webReplicas * (2 * setup.poolMax + QUEUE_SENDER) + setup.workers * (2 * setup.poolMax + QUEUE_WORKER);
}
