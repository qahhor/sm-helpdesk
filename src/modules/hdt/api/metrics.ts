import 'server-only';
import * as z from 'zod';
import { type SystemActor, withActor } from '@/db/with-actor';
import { consumeRateLimit, FRESH_SIGN_IN_SEC, isFresh, rateKey, readSetting, writeSettingTx } from '@/modules/hdc/api';
import { pilotRunStats } from '@/modules/hda/api/metrics';
import { cleanUserText, RATE_RULES } from '@/modules/hdc/pref';
import { listActiveModules, moduleCodesTx, type Priority, readSlaConfig, type SlaConfig } from '@/modules/hdr/api';
import { getOrganization, namesOf, type StaffContext } from '@/modules/hdu/api';
import { orgFactsTx } from '@/modules/hdu/api/automation';
import {
  assistantStatsTx,
  auditAsStaff,
  breakdownTx,
  type Counters,
  lineEventsTx,
  lowRatingsTx,
  finishedTx,
  pilotCountersTx,
  type Range,
  requestRowsTx,
  resolvedRowsTx,
  respondedRowsTx,
  saveCsatReviewTx,
  sourceCountersTx,
} from '../core/metrics';
import { calendarFor } from '../core/sla';
import { HdtError } from '../error';
import { numberInput, parseInput } from '../input';
import { PILOT_METRICS, PILOT_ORGS_MAX, PILOT_ORGS_SETTING, PILOT_TARGETS, type PilotMetricKey } from '../pref';
import { average, channelOfSource, combineCounters, CSV_MAX_ROWS, type CsvValue, decimal, type Line, LINES, lineUsage, localMinute, median, parsePeriod, percent, type Period, TICKET_CHANNELS, type TicketChannel } from '../metrics-util';
import { workingMinutesBetween } from '../sla';
import { noProtoKeys } from '@/lib/no-proto';

// Модуль hdt, слой api: показатели поддержки (FR-MET-01, 03, 04, 07, 10, FR-LINE-08; план M8, задача 9,
// решения 14-16). Сотрудник из проверенной сессии, вход по схеме, права проверяются здесь, а не скрытием кнопок.
// Определения показателей записаны в core/metrics.ts и в подсказках страницы. Кеша нет: каждый показ считает заново.

export { buildCsv, CSV_MAX_ROWS, type Line, LINES, METRICS_MAX_DAYS, METRICS_PRESETS, type Period, splitMinutes, TICKET_CHANNELS, type TicketChannel } from '../metrics-util';

/** Сколько обращений берётся в расчёт времени и линий. Больше: страница говорит "посчитано по первым N". */
export const METRICS_ROW_CAP = 20_000;
/** Строк среза на один шаг "Показать ещё". */
export const BREAKDOWN_PAGE = 50;
const BREAKDOWN_MAX_PAGES = 40;
/** Низких оценок на странице. */
export const LOW_RATINGS_LIMIT = 200;
export const CSAT_REVIEW_MAX = 2000;
export const METRICS_REPORTS = ['orgs', 'modules', 'low_ratings', 'requests', 'pilot'] as const;
export type MetricsReport = (typeof METRICS_REPORTS)[number];

const BREAKDOWN_ROLES: readonly string[] = ['care', 'product', 'admin'];
const REVIEW_ROLES: readonly string[] = ['care', 'admin'];

function requireStaff(ctx: StaffContext): void {
  const actor = ctx?.actor as { type?: string } | undefined;
  if (actor?.type !== 'staff') throw new HdtError('forbidden');
}

/** Срез по организациям и выгрузка (решение 14): Customer Care, продукт, администратор и руководители линий. */
export function canSeeBreakdown(ctx: StaffContext): boolean {
  return ctx?.actor?.type === 'staff' && (BREAKDOWN_ROLES.includes(ctx.actor.staffRole) || ctx.isLead === true);
}

/** Заметку о разборе низкой оценки пишут Customer Care и администратор (решение 14). */
export function canReviewCsat(ctx: StaffContext): boolean {
  return ctx?.actor?.type === 'staff' && REVIEW_ROLES.includes(ctx.actor.staffRole);
}

const periodInput = z.object({ period: noProtoKeys(z.unknown()).optional(), from: noProtoKeys(z.unknown()).optional(), to: noProtoKeys(z.unknown()).optional(), noProblems: noProtoKeys(z.unknown()).optional() });
/** Фильтр "без известных проблем" (FR-KP-13): галочка формы или true. */
const withoutProblemsOf = (input: unknown): boolean => {
  const value = typeof input === 'object' && input !== null ? (input as { noProblems?: unknown }).noProblems : undefined;
  return value === true || value === 'on' || value === '1' || value === 'true';
};

type Share = { total: number; ok: number; percent: number | null };
type Timing = { count: number; averageMinutes: number | null; medianMinutes: number | null };

export type MetricsOverview = {
  created: number;
  resolved: number;
  closed: number;
  /** Решено или закрыто в периоде, когда бы ни создано: единственное число страницы не по дате создания. */
  finished: number;
  firstResponse: Share;
  resolution: Share;
  firstResponseTime: Timing;
  resolutionTime: Timing;
  csat: { count: number; average: number | null; highPercent: number | null };
};
export type ChannelRow = {
  channel: TicketChannel;
  count: number;
  percent: number | null;
  resolved: number;
  firstResponsePercent: number | null;
  resolutionPercent: number | null;
  csatAverage: number | null;
};
export type LineRow = { line: Line; resolved: number; percent: number | null; visited: number; averageMinutes: number | null };
export type LowRating = {
  number: number;
  orgName: string | null;
  assigneeName: string | null;
  score: number;
  reason: string | null;
  comment: string | null;
  createdOn: Date;
  reviewNote: string | null;
  reviewedByName: string | null;
  reviewedOn: Date | null;
};
export type MetricsView = {
  period: Period;
  /** Обращения, привязанные к известным проблемам, исключены (FR-KP-13). */
  withoutProblems: boolean;
  timeZone: string;
  overview: MetricsOverview;
  sources: { source: string; count: number; percent: number | null }[];
  /** Каналы в постоянном порядке TICKET_CHANNELS, пустые тоже (FR-MET-10). */
  channels: ChannelRow[];
  lines: { resolved: number; rows: LineRow[]; returns: number };
  lowRatings: { items: LowRating[]; capped: boolean };
  /** Время и линии посчитаны по первым METRICS_ROW_CAP обращениям периода: обращений больше. */
  capped: boolean;
};

async function resolvePeriod(ctx: StaffContext, input: unknown, now: Date): Promise<{ period: Period; config: SlaConfig }> {
  const data = parseInput(periodInput, input ?? {});
  const config = await withActor(ctx.actor, readSlaConfig);
  const period = parsePeriod(data, now, config.calendar.timeZone);
  if (!period) throw new HdtError('invalid_input');
  return { period, config };
}

const share = (ok: number, total: number): Share => ({ total, ok, percent: percent(ok, total) });
const timing = (minutes: number[]): Timing => ({ count: minutes.length, averageMinutes: average(minutes), medianMinutes: median(minutes) });
const calendarOf = (config: SlaConfig, priority: string) => calendarFor(config, priority as Priority);

/** Рабочие минуты от создания до решения без пауз "Ждём вашего ответа": так же срок решения считает SLA (FR-SLA-05). */
const resolutionMinutes = (row: { createdOn: Date; resolvedOn: Date; priority: string; pausedMinutes: number }, config: SlaConfig): number =>
  Math.max(0, workingMinutesBetween(row.createdOn, row.resolvedOn, calendarOf(config, row.priority)) - row.pausedMinutes);

const overviewOf = (c: Counters, finished: number, firstResponseTime: Timing, resolutionTime: Timing): MetricsOverview => ({
  created: c.created,
  resolved: c.resolved,
  closed: c.closed,
  finished,
  firstResponse: share(c.firstResponseOk, c.firstResponseTotal),
  resolution: share(c.resolutionOk, c.resolutionTotal),
  firstResponseTime,
  resolutionTime,
  csat: { count: c.rated, average: c.csatAverage, highPercent: percent(c.csatHigh, c.rated) },
});

/**
 * Страница показателей: сводка, источники, линии, низкие оценки. Видят все сотрудники (решение 14).
 * Время первого ответа и решения считается в рабочих минутах тем же календарём, что сроки SLA. Рабочее время между
 * двумя моментами в SQL не выразить (календарь и праздники лежат в настройках), поэтому оно считается в коде по
 * строкам периода, не больше METRICS_ROW_CAP строк.
 */
export async function getMetrics(ctx: StaffContext, input: unknown, now: Date = new Date()): Promise<MetricsView> {
  requireStaff(ctx);
  const { period, config } = await resolvePeriod(ctx, input, now);
  const withoutProblems = withoutProblemsOf(input);
  const range: Range = { from: period.from, to: period.to, withoutProblems };
  const { bySource, finished, responded, resolved, events, low } = await withActor(ctx.actor, async (tx) => {
    const resolvedRows = await resolvedRowsTx(tx, range, METRICS_ROW_CAP + 1);
    return {
      bySource: await sourceCountersTx(tx, range, now),
      finished: await finishedTx(tx, range),
      responded: await respondedRowsTx(tx, range, METRICS_ROW_CAP + 1),
      resolved: resolvedRows,
      events: await lineEventsTx(tx, resolvedRows.slice(0, METRICS_ROW_CAP).map((row) => row.ticketId)),
      low: await lowRatingsTx(tx, range, LOW_RATINGS_LIMIT + 1),
    };
  });
  // Сводка, источники и каналы из одного просмотра по источникам (замер подготовки M9, задача 4).
  const counters = combineCounters(bySource);
  const sources = bySource.map((row) => ({ source: row.source, count: row.created }));
  const channels = TICKET_CHANNELS.flatMap((channel) => {
    const rows = bySource.filter((row) => channelOfSource(row.source) === channel);
    return rows.length > 0 ? [{ channel, ...combineCounters(rows) }] : [];
  });
  const capped = responded.length > METRICS_ROW_CAP || resolved.length > METRICS_ROW_CAP;
  const respondedRows = responded.slice(0, METRICS_ROW_CAP);
  const resolvedRows = resolved.slice(0, METRICS_ROW_CAP);

  const perLine = new Map<Line, { resolved: number; visited: number; minutes: number }>(LINES.map((line) => [line, { resolved: 0, visited: 0, minutes: 0 }]));
  let returns = 0;
  for (const row of resolvedRows) {
    const usage = lineUsage(row, events.get(row.ticketId) ?? [], calendarOf(config, row.priority));
    returns += usage.returns;
    (perLine.get(usage.resolvedLine) as { resolved: number }).resolved += 1;
    for (const line of LINES) {
      const spent = usage.minutes[line];
      if (spent === undefined) continue;
      const total = perLine.get(line) as { visited: number; minutes: number };
      total.visited += 1;
      total.minutes += spent;
    }
  }

  const lowRows = low.slice(0, LOW_RATINGS_LIMIT);
  const orgs = await withActor(ctx.actor, (tx) => orgFactsTx(tx, lowRows.map((row) => row.orgId)));
  const people = await namesOf(ctx.actor, lowRows.flatMap((row) => [row.assigneeId, row.reviewedBy]).filter((id): id is string => id !== null));
  const total = counters.created;
  return {
    period,
    withoutProblems,
    timeZone: config.calendar.timeZone,
    overview: overviewOf(
      counters,
      finished,
      timing(respondedRows.map((row) => workingMinutesBetween(row.createdOn, row.firstRespondedOn, calendarOf(config, row.priority)))),
      timing(resolvedRows.map((row) => resolutionMinutes(row, config))),
    ),
    sources: sources.map((row) => ({ ...row, percent: percent(row.count, total) })).sort((a, b) => b.count - a.count || a.source.localeCompare(b.source)),
    channels: TICKET_CHANNELS.map((channel) => {
      const row = channels.find((item) => item.channel === channel);
      return {
        channel,
        count: row?.created ?? 0,
        percent: percent(row?.created ?? 0, total),
        resolved: row?.resolved ?? 0,
        firstResponsePercent: row ? percent(row.firstResponseOk, row.firstResponseTotal) : null,
        resolutionPercent: row ? percent(row.resolutionOk, row.resolutionTotal) : null,
        csatAverage: row?.csatAverage ?? null,
      };
    }),
    lines: {
      resolved: resolvedRows.length,
      rows: LINES.map((line) => {
        const row = perLine.get(line) as { resolved: number; visited: number; minutes: number };
        return { line, resolved: row.resolved, percent: percent(row.resolved, resolvedRows.length), visited: row.visited, averageMinutes: row.visited > 0 ? row.minutes / row.visited : null };
      }),
      returns,
    },
    lowRatings: {
      items: lowRows.map((row) => ({
        number: row.number,
        orgName: orgs.get(row.orgId)?.name ?? null,
        assigneeName: row.assigneeId ? (people.get(row.assigneeId) ?? null) : null,
        score: row.score,
        reason: row.reason,
        comment: row.comment,
        createdOn: row.createdOn,
        reviewNote: row.reviewNote,
        reviewedByName: row.reviewedBy ? (people.get(row.reviewedBy) ?? null) : null,
        reviewedOn: row.reviewedOn,
      })),
      capped: low.length > LOW_RATINGS_LIMIT,
    },
    capped,
  };
}

export type BreakdownItem = {
  key: string | null;
  name: string | null;
  created: number;
  resolved: number;
  firstResponsePercent: number | null;
  resolutionPercent: number | null;
  csatCount: number;
  csatAverage: number | null;
};
export type Breakdown = { period: Period; items: BreakdownItem[]; hasMore: boolean; pages: number };

const breakdownInput = periodInput.extend({ by: z.enum(['org', 'module']), pages: z.coerce.number().int().min(1).max(BREAKDOWN_MAX_PAGES).optional(), locale: z.string().max(10).optional() });

async function breakdownItems(ctx: StaffContext, range: Range, by: 'org' | 'module', now: Date, limit: number, locale: string): Promise<{ items: BreakdownItem[]; hasMore: boolean }> {
  const { rows, orgs, codes } = await withActor(ctx.actor, async (tx) => {
    const found = await breakdownTx(tx, range, by, now, { limit: limit + 1, offset: 0 });
    const keys = found.slice(0, limit).flatMap((row) => (row.key ? [row.key] : []));
    return { rows: found, orgs: by === 'org' ? await orgFactsTx(tx, keys) : null, codes: by === 'module' ? await moduleCodesTx(tx, keys) : null };
  });
  // Название модуля на языке страницы; отключённый модуль показывается кодом.
  const modules = by === 'module' ? new Map((await listActiveModules(ctx.actor, locale)).map((m) => [m.moduleId, m.name])) : null;
  const nameOf = (key: string | null) => (key === null ? null : by === 'org' ? (orgs?.get(key)?.name ?? null) : (modules?.get(key) ?? codes?.get(key) ?? null));
  return {
    items: rows.slice(0, limit).map((row) => ({
      key: row.key,
      name: nameOf(row.key),
      created: row.created,
      resolved: row.resolved,
      firstResponsePercent: percent(row.firstResponseOk, row.firstResponseTotal),
      resolutionPercent: percent(row.resolutionOk, row.resolutionTotal),
      csatCount: row.rated,
      csatAverage: row.csatAverage,
    })),
    hasMore: rows.length > limit,
  };
}

/** Срез по организациям или модулям (FR-MET-04): первые 50 строк по числу обращений, "Показать ещё" добавляет по 50. */
export async function getMetricsBreakdown(ctx: StaffContext, input: unknown, now: Date = new Date()): Promise<Breakdown> {
  if (!canSeeBreakdown(ctx)) throw new HdtError('forbidden');
  const data = parseInput(breakdownInput, input ?? {});
  const { period } = await resolvePeriod(ctx, data, now);
  const pages = data.pages ?? 1;
  const found = await breakdownItems(ctx, { from: period.from, to: period.to }, data.by, now, pages * BREAKDOWN_PAGE, data.locale ?? 'ru');
  return { period, pages, ...found };
}

const reviewInput = z.object({ number: numberInput, note: z.string().overwrite(cleanUserText).trim().min(1).max(CSAT_REVIEW_MAX) });

/** Заметка о разборе низкой оценки (FR-MET-07): Customer Care и администратор, только к оценке от 1 до 3. */
export async function saveCsatReview(ctx: StaffContext, input: unknown): Promise<void> {
  if (!canReviewCsat(ctx)) throw new HdtError('forbidden');
  const data = parseInput(reviewInput, input);
  await saveCsatReviewTx(ctx.actor, data.number, data.note);
}

const exportInput = periodInput.extend({ report: z.enum(METRICS_REPORTS), locale: z.string().max(10).optional() });

export type MetricsExport = {
  report: MetricsReport;
  period: Period;
  /** Ключи колонок: заголовки на языке сотрудника подставляет обработчик адреса. */
  columns: readonly string[];
  rows: CsvValue[][];
  /** Строк больше CSV_MAX_ROWS: файл говорит об этом первой строкой. */
  truncated: boolean;
};

export const EXPORT_COLUMNS = {
  orgs: ['org', 'created', 'resolved', 'firstResponsePercent', 'resolutionPercent', 'csatCount', 'csatAverage'],
  modules: ['module', 'created', 'resolved', 'firstResponsePercent', 'resolutionPercent', 'csatCount', 'csatAverage'],
  low_ratings: ['number', 'created', 'org', 'assignee', 'score', 'reason', 'comment', 'reviewNote', 'reviewedBy', 'reviewed'],
  requests: ['number', 'created', 'org', 'module', 'type', 'priority', 'source', 'status', 'firstResponseMinutes', 'resolutionMinutes', 'firstResponseBreached', 'resolutionBreached', 'score'],
  // Сводка пилота (план M9, решение 13): код показателя, значение, цель, выполнена ли (1, 0 или пусто).
  pilot: ['metric', 'value', 'target', 'met'],
} as const satisfies Record<MetricsReport, readonly string[]>;

const flag = (value: boolean): number => (value ? 1 : 0);

/**
 * Выгрузка показателей (FR-MET-04, решение 16): срез по организациям или модулям, низкие оценки, обращения периода
 * по строке на обращение. Права как у среза (решение 14), не больше 20 выгрузок в час на сотрудника, каждая
 * записывается в журнал аудита. В строках обращений нет темы, описания и переписки. Строк не больше CSV_MAX_ROWS.
 */
export async function exportMetrics(ctx: StaffContext, input: unknown, now: Date = new Date()): Promise<MetricsExport> {
  if (!canSeeBreakdown(ctx) && !canSeePilot(ctx)) throw new HdtError('forbidden');
  const data = parseInput(exportInput, input ?? {});
  // Сводку пилота выгружают только те, кто её видит: care и администратор (решение 13 плана M9).
  if (data.report === 'pilot' ? !canSeePilot(ctx) : !canSeeBreakdown(ctx)) throw new HdtError('forbidden');
  const { period, config } = await resolvePeriod(ctx, data, now);
  const limit = await consumeRateLimit(rateKey('metrics-export:user', ctx.actor.userId), RATE_RULES.metricsExportPerUser, now);
  if (!limit.allowed) throw new HdtError('rate_limited', { retryAfterSec: limit.retryAfterSec });
  const range: Range = { from: period.from, to: period.to };
  const zone = config.calendar.timeZone;
  let rows: CsvValue[][];
  let truncated = false;
  if (data.report === 'pilot') {
    const summary = await pilotSummary(ctx, data, now);
    rows = summary.rows.map((row) => [row.key, decimal(row.value), decimal(row.target), row.met === null ? null : flag(row.met)]);
  } else if (data.report === 'orgs' || data.report === 'modules') {
    const found = await breakdownItems(ctx, range, data.report === 'orgs' ? 'org' : 'module', now, CSV_MAX_ROWS, data.locale ?? 'ru');
    truncated = found.hasMore;
    rows = found.items.map((item) => [item.name ?? '', item.created, item.resolved, decimal(item.firstResponsePercent), decimal(item.resolutionPercent), item.csatCount, decimal(item.csatAverage)]);
  } else if (data.report === 'low_ratings') {
    const { low, orgs } = await withActor(ctx.actor, async (tx) => {
      const found = await lowRatingsTx(tx, range, CSV_MAX_ROWS + 1);
      return { low: found, orgs: await orgNames(tx, found.map((row) => row.orgId)) };
    });
    truncated = low.length > CSV_MAX_ROWS;
    const people = await namesOf(ctx.actor, low.flatMap((row) => [row.assigneeId, row.reviewedBy]).filter((id): id is string => id !== null));
    rows = low.slice(0, CSV_MAX_ROWS).map((row) => [
      `SUP-${row.number}`,
      localMinute(row.createdOn, zone),
      orgs.get(row.orgId) ?? '',
      row.assigneeId ? (people.get(row.assigneeId) ?? '') : '',
      row.score,
      row.reason ?? '',
      row.comment ?? '',
      row.reviewNote ?? '',
      row.reviewedBy ? (people.get(row.reviewedBy) ?? '') : '',
      localMinute(row.reviewedOn, zone),
    ]);
  } else {
    const { found, orgs, modules } = await withActor(ctx.actor, async (tx) => {
      const requests = await requestRowsTx(tx, range, CSV_MAX_ROWS + 1);
      return {
        found: requests,
        orgs: await orgNames(tx, requests.map((row) => row.orgId)),
        modules: await moduleCodesTx(tx, requests.flatMap((row) => (row.moduleId ? [row.moduleId] : []))),
      };
    });
    truncated = found.length > CSV_MAX_ROWS;
    rows = found.slice(0, CSV_MAX_ROWS).map((row) => [
      `SUP-${row.number}`,
      localMinute(row.createdOn, zone),
      orgs.get(row.orgId) ?? '',
      row.moduleId ? (modules.get(row.moduleId) ?? '') : '',
      row.type,
      row.priority,
      row.source,
      row.status,
      row.firstRespondedOn ? workingMinutesBetween(row.createdOn, row.firstRespondedOn, calendarOf(config, row.priority)) : null,
      // Время решения только у решённых: открытое заново и дубль его не имеют (как в сводке).
      row.resolvedOn && !row.merged && (row.status === 'resolved' || row.status === 'closed') ? resolutionMinutes({ ...row, resolvedOn: row.resolvedOn }, config) : null,
      flag(row.firstResponseBreached),
      flag(row.resolutionBreached),
      row.score,
    ]);
  }
  await auditAsStaff(ctx.actor, { action: 'metrics.exported', objectType: 'metrics', diff: { report: data.report, from: period.fromDay, to: period.toDay, rows: rows.length, truncated } });
  return { report: data.report, period, columns: EXPORT_COLUMNS[data.report], rows, truncated };
}

/** Названия организаций по идентификаторам, пачками: в выгрузке обращений организаций могут быть тысячи. */
async function orgNames(tx: Parameters<typeof orgFactsTx>[0], orgIds: readonly string[]): Promise<Map<string, string>> {
  const ids = [...new Set(orgIds)];
  const names = new Map<string, string>();
  for (let start = 0; start < ids.length; start += 5000) for (const [orgId, org] of await orgFactsTx(tx, ids.slice(start, start + 5000))) names.set(orgId, org.name);
  return names;
}

/** Имя файла выгрузки: только латиница, цифры и дефис. */
export function exportFileName(report: MetricsReport, period: Period): string {
  return `smartup-hub-${report.replace('_', '-')}-${period.fromDay}-${period.toDay}.csv`;
}

/** Показатели AI-помощника (план M5b, задача 10; FR-MET-06, FR-AI-18) по обращениям, созданным в периоде. */
export type AssistantMetrics = {
  period: Period;
  /** Обращения, которые вёл помощник (ai_state не none). */
  handled: number;
  resolvedByAi: number;
  /** Доля решённых без сотрудника от обращений помощника. */
  resolvedByAiPercent: number | null;
  handoffs: { reason: string; count: number }[];
  /** Время первого ответа помощника в секундах (настенное время: помощник отвечает круглосуточно). */
  firstReply: { count: number; averageSeconds: number | null; medianSeconds: number | null };
  /** Оценки клиентов по обращениям, решённым помощником. */
  csat: { count: number; average: number | null };
  /** Открыты заново после "Помогло". */
  reopenedAfterHelped: number;
};

/**
 * Показатели помощника для инструмента assistant_metrics сервера MCP (веха M8b, задача 5; план M8b, решение 17): те же
 * числа, что на /agent/metrics, за период "с даты по дату" по календарю SLA. Только числа, без текстов; только система.
 */
export async function assistantMetricsForAgent(
  system: SystemActor,
  input: { from: string; to: string },
  now: Date = new Date(),
): Promise<Omit<AssistantMetrics, 'period'> & { period: { from: Date; to: Date } }> {
  if (system.type !== 'system') throw new HdtError('forbidden');
  const config = await withActor(system, readSlaConfig);
  const period = parsePeriod({ period: 'custom', from: input.from, to: input.to }, now, config.calendar.timeZone);
  if (!period) throw new HdtError('invalid_input');
  const stats = await withActor(system, (tx) => assistantStatsTx(tx, { from: period.from, to: period.to }));
  return {
    period: { from: period.from, to: period.to },
    handled: stats.handled,
    resolvedByAi: stats.resolvedByAi,
    resolvedByAiPercent: percent(stats.resolvedByAi, stats.handled),
    handoffs: stats.handoffs,
    firstReply: { count: stats.firstReplySeconds.length, averageSeconds: average(stats.firstReplySeconds), medianSeconds: median(stats.firstReplySeconds) },
    csat: { count: stats.csatCount, average: stats.csatCount > 0 ? stats.csatSum / stats.csatCount : null },
    reopenedAfterHelped: stats.reopenedAfterHelped,
  };
}

export async function getAssistantMetrics(ctx: StaffContext, input: unknown, now: Date = new Date()): Promise<AssistantMetrics> {
  requireStaff(ctx);
  const { period } = await resolvePeriod(ctx, input, now);
  const stats = await withActor(ctx.actor, (tx) => assistantStatsTx(tx, { from: period.from, to: period.to }));
  return {
    period,
    handled: stats.handled,
    resolvedByAi: stats.resolvedByAi,
    resolvedByAiPercent: percent(stats.resolvedByAi, stats.handled),
    handoffs: stats.handoffs,
    firstReply: { count: stats.firstReplySeconds.length, averageSeconds: average(stats.firstReplySeconds), medianSeconds: median(stats.firstReplySeconds) },
    csat: { count: stats.csatCount, average: stats.csatCount > 0 ? stats.csatSum / stats.csatCount : null },
    reopenedAfterHelped: stats.reopenedAfterHelped,
  };
}

// --- Сводка пилота (план M9, задача 3, решения 11 и 13; ТЗ 16.7) ---

const PILOT_ROLES: readonly string[] = ['care', 'admin'];

/** Сводку пилота видят Customer Care и администратор (решение 13). */
export function canSeePilot(ctx: StaffContext): boolean {
  return ctx?.actor?.type === 'staff' && PILOT_ROLES.includes(ctx.actor.staffRole);
}

const pilotIdsSchema = z.array(z.uuid()).max(PILOT_ORGS_MAX);

/** Пилотные организации из настройки pilot.org_ids. Нет строки или значение неверно: пусто. */
async function pilotOrgIds(): Promise<string[]> {
  const parsed = pilotIdsSchema.safeParse(await readSetting(PILOT_ORGS_SETTING));
  return parsed.success ? [...new Set(parsed.data)] : [];
}

/** Входит ли организация в пилот: карточка организации показывает отметку care и администратору. */
export async function isPilotOrg(ctx: StaffContext, orgId: string): Promise<boolean> {
  if (!canSeePilot(ctx)) throw new HdtError('forbidden');
  return (await pilotOrgIds()).includes(orgId);
}

const pilotOrgInput = z.strictObject({ orgId: z.uuid(), pilot: z.boolean() });

/**
 * Отметить организацию пилотной или снять отметку (решение 11): администратор со входом не старше 15 минут, запись
 * settings.changed со списком той же транзакцией. Организация должна существовать и быть клиентом.
 */
export async function setPilotOrg(ctx: StaffContext, input: unknown, now: Date = new Date()): Promise<void> {
  if (ctx?.actor?.type !== 'staff' || ctx.actor.staffRole !== 'admin') throw new HdtError('forbidden');
  if (!isFresh(ctx, now, FRESH_SIGN_IN_SEC)) throw new HdtError('stale_session');
  const data = parseInput(pilotOrgInput, input);
  if (!(await getOrganization(ctx, data.orgId))) throw new HdtError('not_found');
  const current = await pilotOrgIds();
  const next = data.pilot ? [...new Set([...current, data.orgId])] : current.filter((id) => id !== data.orgId);
  if (next.length > PILOT_ORGS_MAX) throw new HdtError('invalid_input');
  if (next.length === current.length && next.every((id, i) => id === current[i])) return;
  await withActor(ctx.actor, (tx) => writeSettingTx(tx, PILOT_ORGS_SETTING, next));
}

export type PilotRow = {
  key: PilotMetricKey;
  /** Доля в процентах, расход в долларах; пусто: считать не из чего (или показатель ведётся вне портала). */
  value: number | null;
  target: number | null;
  direction: 'min' | 'max' | null;
  /** Цель выполнена; пусто: значения или цели нет. */
  met: boolean | null;
  /** Из скольких посчитана доля (обращений, оценок, ответов). */
  base: number | null;
};

export type PilotSummary = { period: Period; timeZone: string; orgCount: number; orgs: { orgId: string; name: string }[]; rows: PilotRow[] };

/**
 * Сводка пилота за период (решение 13): восемь строк таблицы 16.7 и доля пришедших мимо портала в Telegram по
 * организациям из pilot.org_ids. Только числа, без тем и текстов. Без пилотных организаций строк нет.
 */
export async function pilotSummary(ctx: StaffContext, input: unknown, now: Date = new Date()): Promise<PilotSummary> {
  if (!canSeePilot(ctx)) throw new HdtError('forbidden');
  const { period, config } = await resolvePeriod(ctx, input, now);
  const ids = await pilotOrgIds();
  const names = await withActor(ctx.actor, (tx) => orgFactsTx(tx, ids));
  const orgs = ids.flatMap((orgId) => {
    const org = names.get(orgId);
    return org ? [{ orgId, name: org.name }] : [];
  });
  if (orgs.length === 0) return { period, timeZone: config.calendar.timeZone, orgCount: 0, orgs: [], rows: [] };
  const orgIds = orgs.map((org) => org.orgId);
  const range: Range = { from: period.from, to: period.to };
  const c = await withActor(ctx.actor, (tx) => pilotCountersTx(tx, range, orgIds, now));
  const runs = await pilotRunStats(ctx, { from: period.from, to: period.to, orgIds });
  const costTarget = Math.round(((PILOT_TARGETS.ai_cost.target ?? 0) * period.days * 100) / 30) / 100;
  const values: Record<PilotMetricKey, { value: number | null; base: number | null; target?: number }> = {
    portal_share: { value: percent(c.total - c.bypass, c.total), base: c.total },
    first_response: { value: percent(c.firstResponseOk, c.firstResponseTotal), base: c.firstResponseTotal },
    resolution: { value: percent(c.resolutionOk, c.resolutionTotal), base: c.resolutionTotal },
    ai_resolved: { value: percent(c.aiResolved, c.aiHandled), base: c.aiHandled },
    ai_resolved_all: { value: percent(c.aiResolved, c.total), base: c.total },
    ai_flagged: { value: percent(runs.flagged, runs.answers), base: runs.answers },
    csat_high: { value: percent(c.csatHigh, c.rated), base: c.rated },
    leaks: { value: null, base: null },
    ai_cost: { value: runs.costUsd, base: null, target: costTarget },
    telegram_share: { value: percent(c.telegram, c.total), base: c.total },
  };
  const rows = PILOT_METRICS.map((key): PilotRow => {
    const { direction } = PILOT_TARGETS[key];
    const target = values[key].target ?? PILOT_TARGETS[key].target;
    const value = values[key].value;
    const met = value === null || target === null || direction === null ? null : direction === 'min' ? value >= target : value <= target;
    return { key, value, target, direction, met, base: values[key].base };
  });
  return { period, timeZone: config.calendar.timeZone, orgCount: orgs.length, orgs, rows };
}
