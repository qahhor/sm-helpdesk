import type { Queue, TicketStatus } from './pref';
import { type Calendar, workingMinutesBetween, zonedToDate } from './sla';

// Модуль hdt, слой util: чистые функции показателей (FR-MET-01, 03, 04, 07, 10, FR-LINE-08; план M8, задача 9,
// решения 15 и 16). Разбор периода, расчёт линии по событиям обращения, сборка CSV. Базы здесь нет.

/** Самый длинный свой период в днях (решение 15: не длиннее года; високосный год входит целиком). */
export const METRICS_MAX_DAYS = 366;
export const METRICS_PRESETS = ['7', '30', '90'] as const;
export type MetricsPreset = (typeof METRICS_PRESETS)[number] | 'custom';

export type Period = {
  preset: MetricsPreset;
  /** Начало первого дня периода в часовом поясе календаря поддержки. */
  from: Date;
  /** Начало дня после последнего: граница не входит. */
  to: Date;
  /** Первый и последний день периода, оба входят: 'ГГГГ-ММ-ДД'. */
  fromDay: string;
  toDay: string;
  days: number;
};

const DAY_MS = 86_400_000;
const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** Местная дата момента в часовом поясе: 'ГГГГ-ММ-ДД'. */
export function localDay(instant: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(instant);
}

/** Местные дата и время момента: 'ГГГГ-ММ-ДД ЧЧ:ММ'. Для ячеек CSV. */
export function localMinute(instant: Date | null, timeZone: string): string {
  if (!instant) return '';
  const parts: Record<string, string> = {};
  for (const part of new Intl.DateTimeFormat('en-CA', { timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).formatToParts(instant))
    parts[part.type] = part.value;
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`;
}

/** Номер дня от начала эпохи для календарной даты. Несуществующая дата: null. */
function dayNumber(day: string): number | null {
  if (!DAY_PATTERN.test(day)) return null;
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  const at = new Date(Date.UTC(y, m - 1, d));
  if (at.getUTCFullYear() !== y || at.getUTCMonth() !== m - 1 || at.getUTCDate() !== d) return null;
  return Math.round(at.getTime() / DAY_MS);
}

const dayOf = (number: number): string => new Date(number * DAY_MS).toISOString().slice(0, 10);

/**
 * Период страницы показателей из параметров адреса. Готовые периоды 7, 30 и 90 дней кончаются сегодняшним днём
 * (он входит), свой период задаётся двумя датами, обе входят. Дни считаются в часовом поясе календаря поддержки.
 * Период не назван: 30 дней. Негодные данные: null, страница покажет ошибку, выгрузка ответит 400.
 */
export function parsePeriod(input: { period?: unknown; from?: unknown; to?: unknown }, now: Date, timeZone: string): Period | null {
  const preset = input.period === undefined || input.period === null || input.period === '' ? '30' : input.period;
  if (typeof preset !== 'string') return null;
  let first: number | null;
  let last: number | null;
  if (preset === 'custom') {
    if (typeof input.from !== 'string' || typeof input.to !== 'string') return null;
    first = dayNumber(input.from);
    last = dayNumber(input.to);
  } else if ((METRICS_PRESETS as readonly string[]).includes(preset)) {
    last = dayNumber(localDay(now, timeZone));
    first = last === null ? null : last - Number(preset) + 1;
  } else return null;
  if (first === null || last === null || last < first || last - first + 1 > METRICS_MAX_DAYS) return null;
  const fromDay = dayOf(first);
  const toDay = dayOf(last);
  try {
    return {
      preset: preset as MetricsPreset,
      from: zonedToDate(`${fromDay}T00:00`, timeZone),
      to: zonedToDate(`${dayOf(last + 1)}T00:00`, timeZone),
      fromDay,
      toDay,
      days: last - first + 1,
    };
  } catch {
    return null;
  }
}

/** Доля в процентах с одним знаком после запятой. Делить не на что: null. */
export function percent(part: number, total: number): number | null {
  return total > 0 ? Math.round((part / total) * 1000) / 10 : null;
}

export function average(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? (sorted[middle] as number) : ((sorted[middle - 1] as number) + (sorted[middle] as number)) / 2;
}

/** Число для ячейки CSV: до двух знаков, десятичная запятая (файл с точкой с запятой открывают в Excel с русскими настройками). */
export function decimal(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return '';
  return String(Math.round(value * 100) / 100).replace('.', ',');
}

/** Минуты как часы и минуты для подписи "2 ч 15 мин". */
export function splitMinutes(total: number): { hours: number; minutes: number } {
  const rounded = Math.max(0, Math.round(total));
  return { hours: Math.floor(rounded / 60), minutes: rounded % 60 };
}

// --- Линии (FR-LINE-08) ---

export const LINES = ['first', 'second', 'development'] as const;

/**
 * Каналы обращений (FR-MET-10; план M6, задача 8): портал, виджет (Smartup Web и мобильное приложение вместе), почта.
 * Созданные сотрудником идут отдельной строкой, чтобы доли складывались в 100%.
 */
export const TICKET_CHANNELS = ['portal', 'widget', 'email', 'staff'] as const;
export type TicketChannel = (typeof TICKET_CHANNELS)[number];

/** Канал источника обращения (FR-MET-10): оба источника виджета дают канал widget. */
export function channelOfSource(source: string): string {
  return source === 'widget_web' || source === 'widget_mobile' ? 'widget' : source;
}

/** Счётчики, общие для сводки и срезов (core/metrics.ts). */
export type Counters = {
  created: number;
  resolved: number;
  closed: number;
  firstResponseTotal: number;
  firstResponseOk: number;
  resolutionTotal: number;
  resolutionOk: number;
  rated: number;
  csatAverage: number | null;
  csatHigh: number;
};

/** Счётчики одного источника: сумма оценок вместо средней, чтобы строки можно было складывать. */
export type AdditiveCounters = Omit<Counters, 'csatAverage'> & { csatSum: number };

/**
 * Сумма счётчиков нескольких строк (замер подготовки M9, задача 4): сводка и каналы складываются из строк источников
 * одного просмотра обращений периода. Средняя оценка: сумма оценок на число оценок.
 */
export function combineCounters(rows: readonly AdditiveCounters[]): Counters {
  const sum = (pick: (row: AdditiveCounters) => number) => rows.reduce((total, row) => total + pick(row), 0);
  const rated = sum((row) => row.rated);
  return {
    created: sum((row) => row.created),
    resolved: sum((row) => row.resolved),
    closed: sum((row) => row.closed),
    firstResponseTotal: sum((row) => row.firstResponseTotal),
    firstResponseOk: sum((row) => row.firstResponseOk),
    resolutionTotal: sum((row) => row.resolutionTotal),
    resolutionOk: sum((row) => row.resolutionOk),
    rated,
    csatAverage: rated > 0 ? sum((row) => row.csatSum) / rated : null,
    csatHigh: sum((row) => row.csatHigh),
  };
}
export type Line = (typeof LINES)[number];

/**
 * Линия обращения (ТЗ 10.5): статус "В разработке" это разработка, очередь l1 первая линия, очереди l2 и care вторая.
 * Линии AI-помощника пока нет: помощник появится в вехе M5b.
 */
export function lineOf(queue: Queue | string, status: TicketStatus | string): Line {
  if (status === 'in_development') return 'development';
  return queue === 'l1' ? 'first' : 'second';
}

/** Событие истории обращения, из которого считается линия: смена очереди или статуса. */
export type LineEvent = { kind: 'queue' | 'status'; from: string | null; to: string | null; at: Date };
export type LineUsage = { resolvedLine: Line; minutes: Partial<Record<Line, number>>; returns: number };

/**
 * Путь решённого обращения по линиям от создания до решения.
 *
 * Правило (FR-LINE-08, решение 15): в каждый момент обращение на одной линии, она вычисляется из очереди и статуса
 * на этот момент. Очередь и статус восстанавливаются по событиям истории "queue" и "status": их пишут и сотрудник,
 * и правило автоматизации, поэтому передача правилом тоже учтена. Обращение решено на той линии, где оно было
 * прямо перед переходом в "Решено": "В разработке" даёт разработку, иначе линия очереди. Время на линии: рабочие
 * минуты по календарю срока. Возврат: смена очереди со второй линии (l2, care) на первую.
 */
export function lineUsage(ticket: { createdOn: Date; resolvedOn: Date; queue: string }, events: readonly LineEvent[], cal: Calendar): LineUsage {
  const end = ticket.resolvedOn.getTime();
  const sorted = [...events].sort((a, b) => a.at.getTime() - b.at.getTime());
  const firstMove = sorted.find((event) => event.kind === 'queue');
  // Очередь при создании: откуда ушла первая передача. Передач не было: очередь не менялась.
  let queue = firstMove ? (firstMove.from ?? 'l1') : ticket.queue;
  let status = 'new';
  let cursor = ticket.createdOn;
  let returns = 0;
  const minutes: Partial<Record<Line, number>> = {};
  const spend = (until: Date) => {
    const line = lineOf(queue, status);
    minutes[line] = (minutes[line] ?? 0) + workingMinutesBetween(cursor, until, cal);
    cursor = until.getTime() > cursor.getTime() ? until : cursor;
  };
  // Последний переход в "Решено" не позже момента решения: его прежний статус говорит, где решили.
  let beforeResolve: string | null = null;
  for (const event of sorted) {
    if (event.at.getTime() > end) break;
    if (event.kind === 'status' && event.to === 'resolved') {
      beforeResolve = event.from ?? status;
      continue;
    }
    spend(event.at);
    if (event.kind === 'queue') {
      if (event.to === 'l1' && (event.from === 'l2' || event.from === 'care')) returns += 1;
      queue = event.to ?? queue;
    } else status = event.to ?? status;
  }
  spend(ticket.resolvedOn);
  return { resolvedLine: lineOf(queue, beforeResolve ?? status), minutes, returns };
}

// --- CSV (решение 16) ---

/** Метка порядка байтов: с ней Excel читает файл как UTF-8. */
export const CSV_BOM = '﻿';
export const CSV_SEPARATOR = ';';
/** Больше строк выгрузка не отдаёт: файл говорит об этом первой строкой. */
export const CSV_MAX_ROWS = 50_000;

export type CsvValue = string | number | null | undefined;

/**
 * Ячейка CSV. Текст, который начинается с "=", "+", "-", "@", табуляции или возврата каретки, Excel считает
 * формулой: такой текст получает апостроф впереди (решение 16; пункт 6 проверки вехи). Пробелы перед знаком формулу
 * не прячут. Числа, которые пишет сам портал, передаются числом и апостроф не получают. Кавычки по RFC 4180.
 */
export function csvCell(value: CsvValue): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '';
  const text = /^[\t\r]|^\s*[=+\-@]/.test(value) ? `'${value}` : value;
  return /[";\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

/** Файл CSV: метка порядка байтов, разделитель точка с запятой, строки кончаются CRLF. notice: первая строка об усечении. */
export function buildCsv(header: readonly string[], rows: Iterable<readonly CsvValue[]>, opts: { notice?: string } = {}): string {
  const lines: string[] = [];
  if (opts.notice) lines.push(csvCell(opts.notice));
  lines.push(header.map(csvCell).join(CSV_SEPARATOR));
  for (const row of rows) lines.push(row.map(csvCell).join(CSV_SEPARATOR));
  return `${CSV_BOM}${lines.join('\r\n')}\r\n`;
}
