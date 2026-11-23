import { format } from 'node:util';
import { applyLogLevel, type LogLevel } from './log-level';

// Журнал процесса строками JSON (ТЗ 13.8; аудит 23.11.2026, находки O1 и S4). Одна строка на запись: время, уровень,
// событие, поля. Поля с именами секретов вырезаются, текст ограничен: в журнал не попадают токены и длинные тела.
// Прежние вызовы console остаются: installJsonConsole переводит их в тот же формат с событием "log".

const SECRET_KEY = /token|secret|password|authorization|cookie|api[-_]?key|signature/i;
const CUT = '[вырезано]';
const TEXT_MAX = 2000;
const DEPTH_MAX = 4;
/** Поля самой строки: их нельзя перекрыть полями события. */
const RESERVED = new Set(['time', 'level', 'event']);

export type LogFields = Record<string, unknown>;
type Sink = (level: LogLevel, event: string, fields?: LogFields) => void;
type ConsoleLike = Pick<Console, 'debug' | 'info' | 'log' | 'warn' | 'error'>;

function clean(value: unknown, depth: number): unknown {
  if (typeof value === 'string') return value.length > TEXT_MAX ? `${value.slice(0, TEXT_MAX)}...` : value;
  if (value === null || typeof value !== 'object') return typeof value === 'bigint' ? String(value) : value;
  if (value instanceof Error) return { name: value.name, message: clean(value.message, depth) };
  if (value instanceof Date) return value.toISOString();
  if (depth >= DEPTH_MAX) return '[глубже не пишется]';
  if (Array.isArray(value)) return value.slice(0, 50).map((item) => clean(item, depth + 1));
  const out: LogFields = {};
  for (const [key, nested] of Object.entries(value)) out[key] = SECRET_KEY.test(key) ? CUT : clean(nested, depth + 1);
  return out;
}

/** Строка журнала. Чистая функция: её проверяют тесты. */
export function formatLine(level: LogLevel, event: string, fields: LogFields = {}, now: Date = new Date()): string {
  const line: LogFields = { time: now.toISOString(), level, event };
  for (const [key, value] of Object.entries(clean(fields, 0) as LogFields)) if (!RESERVED.has(key)) line[key] = value;
  return JSON.stringify(line);
}

const ORDER: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };
const shared = globalThis as typeof globalThis & { __hubLogJson?: boolean; __hubLogLevel?: LogLevel; __hubLogSink?: Sink | null };

/**
 * Переводит console процесса в строки JSON. Вызывается один раз при запуске портала и фонового процесса, когда
 * LOG_FORMAT=json (по умолчанию в production). В разработке журнал остаётся текстом: письма печатаются в окне.
 */
export function installJsonConsole(
  target: ConsoleLike = console,
  write: (line: string) => void = (line) => void process.stdout.write(`${line}\n`),
  now: () => Date = () => new Date(),
): void {
  const method = (level: LogLevel) => (...args: unknown[]) => write(formatLine(level, 'log', { msg: format(...args) }, now()));
  target.debug = method('debug');
  target.info = method('info');
  target.log = method('info');
  target.warn = method('warn');
  target.error = method('error');
}

/** Настройка журнала процесса при запуске: формат и уровень (LOG_FORMAT, LOG_LEVEL). */
export function configureLog(opts: { level: LogLevel; json: boolean }): void {
  shared.__hubLogLevel = opts.level;
  shared.__hubLogJson = opts.json;
  if (opts.json) installJsonConsole();
  applyLogLevel(opts.level);
}

/** Событие с полями: длительность задачи, медленная транзакция, состояние очереди. */
export function logEvent(level: LogLevel, event: string, fields?: LogFields): void {
  if (shared.__hubLogSink) return shared.__hubLogSink(level, event, fields);
  if (ORDER[level] < ORDER[shared.__hubLogLevel ?? 'info']) return;
  if (shared.__hubLogJson) {
    process.stdout.write(`${formatLine(level, event, fields)}\n`);
    return;
  }
  const out = level === 'debug' ? console.debug : level === 'info' ? console.info : level === 'warn' ? console.warn : console.error;
  out(`${event} ${JSON.stringify(clean(fields ?? {}, 0))}`);
}

/** Приёмник событий для тестов. null возвращает обычный журнал. */
export function setLogSinkForTests(sink: Sink | null): void {
  shared.__hubLogSink = sink;
}

/** Задача дольше этого порога пишется на уровне info, быстрее: на debug. */
export const SLOW_JOB_MS = 1000;

/**
 * Выполняет фоновую задачу и пишет её длительность (аудит 23.11.2026, O1): job.done или job.failed с ошибкой.
 * Ошибка пробрасывается: повторы ведёт очередь задач.
 */
export async function timedJob<T>(job: string, run: () => Promise<T>, clock: () => number = () => performance.now()): Promise<T> {
  const startedAt = clock();
  try {
    const result = await run();
    const ms = Math.round(clock() - startedAt);
    logEvent(ms >= SLOW_JOB_MS ? 'info' : 'debug', 'job.done', { job, ms });
    return result;
  } catch (error) {
    logEvent('error', 'job.failed', { job, ms: Math.round(clock() - startedAt), error });
    throw error;
  }
}
