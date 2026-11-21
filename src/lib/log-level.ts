// Уровень журнала процесса (LOG_LEVEL, раздел 13 ТЗ). Портал пишет журнал через console, поэтому
// уровень применяется к нему: сообщения ниже уровня не печатаются (проверка main, Q11).

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
type ConsoleLike = Pick<Console, 'debug' | 'info' | 'log' | 'warn' | 'error'>;

const silent = () => {};

/** Глушит в переданном журнале методы ниже уровня. */
export function applyLogLevel(level: LogLevel, target: ConsoleLike = console): void {
  if (level === 'debug') return;
  target.debug = silent;
  if (level === 'info') return;
  target.info = silent;
  target.log = silent;
  if (level === 'warn') return;
  target.warn = silent;
}
