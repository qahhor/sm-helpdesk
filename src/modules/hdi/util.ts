import { createHash } from 'node:crypto';

// Модуль hdi, слой util: чистые функции без обращения к базе (docs/naming.md, раздел 5).

/** SHA-256 заголовка и описания: отпечаток текста оригинала для переводов и журнала (без самого текста). */
export function textHash(title: string, body: string): string {
  return createHash('sha256').update(`${title}\n${body}`).digest('hex');
}

/** Идея принята по номеру: "I-204" или "204". */
export function parseIdeaNumber(value: string): number | null {
  const match = /^(?:I-)?(\d{1,10})$/i.exec(value.trim());
  if (!match) return null;
  const number = Number(match[1]);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}

/** Число слов в тексте: форма спрашивает похожие идеи после трёх слов (решение 23). */
export function wordCount(text: string): number {
  return text.split(/[\s\p{P}]+/u).filter((word) => word.length > 0).length;
}

/** Ташкент без перехода на летнее время: UTC+5. Отбор месяца 1-го числа в 09:00 по Ташкенту, это 04:00 UTC (решение 16). */
const CYCLE_HOUR_UTC = 4;
const DAY_MS = 86_400_000;

/**
 * Ближайший отбор месяца после now: начало отбора (1-е число 09:00 по Ташкенту), первое число месяца, голоса которого он
 * соберёт (для строки "Отбор за ноябрь"), и сколько дней осталось (неполный день считается целым).
 */
export function cycleCountdown(now: Date): { endsOn: Date; month: Date; daysLeft: number } {
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();
  const thisStart = Date.UTC(year, month, 1, CYCLE_HOUR_UTC);
  const endsOn = new Date(now.getTime() < thisStart ? thisStart : Date.UTC(year, month + 1, 1, CYCLE_HOUR_UTC));
  const collected = new Date(Date.UTC(endsOn.getUTCFullYear(), endsOn.getUTCMonth() - 1, 1, 12));
  return { endsOn, month: collected, daysLeft: Math.max(1, Math.ceil((endsOn.getTime() - now.getTime()) / DAY_MS)) };
}

/**
 * Отбор месяца, который пора сделать к моменту now (решение 16): первое число текущего месяца по Ташкенту, если уже
 * наступило 1-е число 09:00 по Ташкенту (04:00 UTC), иначе null. В течение месяца ответ тот же: задание, пропустившее
 * утро 1-го числа (процесс не работал), догоняет этот же отбор, а уникальность месяца не даёт второго.
 */
export function cycleDue(now: Date): string | null {
  const local = new Date(now.getTime() + 5 * 3_600_000);
  const year = local.getUTCFullYear();
  const month = local.getUTCMonth();
  if (now.getTime() < Date.UTC(year, month, 1, CYCLE_HOUR_UTC)) return null;
  return `${String(year).padStart(4, '0')}-${String(month + 1).padStart(2, '0')}-01`;
}

/** Дата по Ташкенту (ГГГГ-ММ-ДД): дата выпуска идеи по умолчанию (решение 18). */
export function tashkentDate(now: Date): string {
  return new Date(now.getTime() + 5 * 3_600_000).toISOString().slice(0, 10);
}

/** Месяц, голоса которого собрал отбор: отбор 1 декабря подводит итог ноября ("Отбор за ноябрь"). Полдень UTC для подписи. */
export function cycleMonth(cycle: string): Date {
  const [year, month] = cycle.split('-').map(Number) as [number, number];
  return new Date(Date.UTC(year, month - 2, 1, 12));
}

/**
 * Полные рабочие дни (понедельник-пятница по Ташкенту) между двумя моментами: идея ждёт модерации дольше двух рабочих
 * дней (решение 15). Праздники календаря SLA не учитываются: сводка приходит на день раньше, это безопасно.
 */
export function workingDaysBetween(from: Date, to: Date): number {
  let count = 0;
  for (let cursor = from.getTime(); cursor + DAY_MS <= to.getTime(); cursor += DAY_MS) {
    const weekday = new Date(cursor + 5 * 3_600_000).getUTCDay();
    if (weekday !== 0 && weekday !== 6) count++;
  }
  return count;
}

/** Ссылка в тексте: со схемой (https://, ftp://, tg://), с www. или голое имя узла с доменом верхнего уровня (решение 8). */
const LINK = /(?:\b[a-z][a-z0-9+.-]{1,15}:\/\/|\bwww\.)\S+|\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:uz|ru|com|net|org|io|me|info|biz|app|dev|xyz|su|kz|tj|kg|by|ua)\b/iu;

export function hasLink(text: string): boolean {
  return LINK.test(text);
}
