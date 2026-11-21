// Модуль hdt: расчёт сроков SLA по рабочему календарю (ТЗ, разделы 7.4 и 11.7; решение 0032).
// Чистые функции без базы. Местное время считается через Intl в часовом поясе календаря, поэтому результат
// не зависит от часового пояса процесса. Сроки в минутах идут только по рабочим интервалам, праздник нерабочий
// целиком. Срок в рабочих днях: тот же момент суток через N рабочих дней; если он вне графика этого дня,
// срок сдвигается к концу рабочего дня (7.4).

type Weekday = 0 | 1 | 2 | 3 | 4 | 5 | 6;
/** Рабочий интервал дня по местному времени, 'HH:MM'. */
export type DayHours = [from: string, to: string];
export type WorkCalendar = { timeZone: string; week: Record<Weekday, DayHours | null>; holidays: string[] };
export type Calendar = '24x7' | WorkCalendar;

/** График из раздела 7.4: Пн-Пт 08:00-20:00, Сб 09:00-17:00, Вс выходной, Ташкент. */
export const TASHKENT_DEFAULT: WorkCalendar = {
  timeZone: 'Asia/Tashkent',
  week: { 0: null, 1: ['08:00', '20:00'], 2: ['08:00', '20:00'], 3: ['08:00', '20:00'], 4: ['08:00', '20:00'], 5: ['08:00', '20:00'], 6: ['09:00', '17:00'] },
  holidays: [],
};

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
/** Дальше этого рабочий день не ищется: календарь без рабочих дней - ошибка настройки, а не бесконечный цикл. */
const SEARCH_DAYS = 3660;

type LocalDate = { y: number; m: number; d: number };

const formatters = new Map<string, Intl.DateTimeFormat>();
function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
    formatters.set(timeZone, f);
  }
  return f;
}

/** Местные дата и время момента в часовом поясе. */
function localParts(instant: number, timeZone: string): LocalDate & { minutes: number; seconds: number } {
  const parts: Record<string, number> = {};
  for (const part of formatterFor(timeZone).formatToParts(new Date(instant))) if (part.type !== 'literal') parts[part.type] = Number(part.value);
  return { y: parts.year as number, m: parts.month as number, d: parts.day as number, minutes: (parts.hour as number) * 60 + (parts.minute as number), seconds: parts.second as number };
}

/** Смещение часового пояса в момент времени, мс. */
function offsetAt(instant: number, timeZone: string): number {
  const p = localParts(instant, timeZone);
  return Date.UTC(p.y, p.m - 1, p.d, 0, p.minutes, p.seconds) - Math.floor(instant / 1000) * 1000;
}

/** Момент времени для местных даты и минут суток. Две попытки учитывают переход на летнее время. */
function toInstant(date: LocalDate, minutesOfDay: number, timeZone: string): number {
  const wall = Date.UTC(date.y, date.m - 1, date.d, 0, minutesOfDay);
  const first = wall - offsetAt(wall, timeZone);
  const second = wall - offsetAt(first, timeZone);
  return second;
}

const nextDate = (date: LocalDate): LocalDate => {
  const t = new Date(Date.UTC(date.y, date.m - 1, date.d + 1));
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() };
};
const isoDate = (date: LocalDate) => `${date.y}-${String(date.m).padStart(2, '0')}-${String(date.d).padStart(2, '0')}`;
const weekdayOf = (date: LocalDate) => new Date(Date.UTC(date.y, date.m - 1, date.d)).getUTCDay() as Weekday;
const minutesOf = (hhmm: string) => {
  const [h, m] = hhmm.split(':').map(Number);
  return (h as number) * 60 + (m as number);
};

/** Рабочий интервал местного дня в минутах суток или null: выходной или праздник. */
function hoursOf(date: LocalDate, cal: WorkCalendar): [number, number] | null {
  if (cal.holidays.includes(isoDate(date))) return null;
  const hours = cal.week[weekdayOf(date)];
  return hours ? [minutesOf(hours[0]), minutesOf(hours[1])] : null;
}

/** Рабочие интервалы, начиная с местного дня момента from: [начало, конец] в мс. */
function* intervalsFrom(from: number, cal: WorkCalendar): Generator<[number, number]> {
  let date: LocalDate = localParts(from, cal.timeZone);
  for (let i = 0; i < SEARCH_DAYS; i++, date = nextDate(date)) {
    const hours = hoursOf(date, cal);
    if (hours) yield [toInstant(date, hours[0], cal.timeZone), toInstant(date, hours[1], cal.timeZone)];
  }
  throw new Error('sla: в календаре нет рабочего времени');
}

/** Прибавляет рабочие минуты к моменту времени с учётом календаря. */
export function addWorkingMinutes(from: Date, minutes: number, cal: Calendar): Date {
  if (minutes <= 0) return new Date(from);
  if (cal === '24x7') return new Date(from.getTime() + minutes * MINUTE);
  let left = minutes * MINUTE;
  for (const [start, end] of intervalsFrom(from.getTime(), cal)) {
    if (end <= from.getTime()) continue;
    const begin = Math.max(start, from.getTime());
    if (left <= end - begin) return new Date(begin + left);
    left -= end - begin;
  }
  throw new Error('sla: в календаре нет рабочего времени');
}

/** Первый рабочий момент не раньше from: внутри интервала сам from, иначе начало следующего интервала. */
function firstWorkingMoment(from: number, cal: WorkCalendar): number {
  for (const [start, end] of intervalsFrom(from, cal)) if (end > from) return Math.max(start, from);
  throw new Error('sla: в календаре нет рабочего времени');
}

/** Прибавляет рабочие дни: то же время суток через N рабочих дней, вне графика того дня к его концу. */
export function addWorkingDays(from: Date, days: number, cal: Calendar): Date {
  if (days <= 0) return new Date(from);
  if (cal === '24x7') return new Date(from.getTime() + days * DAY);
  const start = firstWorkingMoment(from.getTime(), cal);
  const local = localParts(start, cal.timeZone);
  let date: LocalDate = local;
  let counted = 0;
  for (let i = 0; i < SEARCH_DAYS && counted < days; i++) {
    date = nextDate(date);
    if (hoursOf(date, cal)) counted += 1;
  }
  const hours = hoursOf(date, cal);
  if (!hours || counted < days) throw new Error('sla: в календаре нет рабочего времени');
  // Тот же момент суток, если он в графике дня (секунды сохраняются), иначе конец рабочего дня.
  const inside = local.minutes >= hours[0] && local.minutes < hours[1];
  return new Date(inside ? toInstant(date, local.minutes, cal.timeZone) + local.seconds * 1000 : toInstant(date, hours[1], cal.timeZone));
}

/** Сколько рабочих минут прошло между двумя моментами. Нужно для паузы. */
export function workingMinutesBetween(a: Date, b: Date, cal: Calendar): number {
  const from = a.getTime();
  const to = b.getTime();
  if (to <= from) return 0;
  if (cal === '24x7') return Math.floor((to - from) / MINUTE);
  let total = 0;
  for (const [start, end] of intervalsFrom(from, cal)) {
    if (start >= to) break;
    total += Math.max(0, Math.min(end, to) - Math.max(start, from));
  }
  return Math.floor(total / MINUTE);
}

/** Местные дата и время 'YYYY-MM-DDTHH:mm' в часовом поясе как момент. Несуществующая дата: исключение. */
export function zonedToDate(local: string, timeZone: string): Date {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(local);
  if (!match) throw new Error('sla: ожидается ГГГГ-ММ-ДДTЧЧ:ММ');
  const [, y, m, d, hh, mm] = match.map(Number) as [number, number, number, number, number, number];
  const check = new Date(Date.UTC(y, m - 1, d));
  if (check.getUTCFullYear() !== y || check.getUTCMonth() !== m - 1 || check.getUTCDate() !== d || hh > 23 || mm > 59) throw new Error('sla: такой даты нет');
  return new Date(toInstant({ y, m, d }, hh * 60 + mm, timeZone));
}

export type SnoozePreset = 'hour' | 'tomorrow' | 'monday';

/** Быстрые варианты "Отложить" (UX-A-11): через час, завтра в 09:00, в ближайший следующий понедельник в 09:00. */
export function snoozeTarget(preset: SnoozePreset, now: Date, timeZone: string): Date {
  if (preset === 'hour') return new Date(now.getTime() + 60 * MINUTE);
  let date: LocalDate = localParts(now.getTime(), timeZone);
  date = nextDate(date);
  if (preset === 'monday') while (weekdayOf(date) !== 1) date = nextDate(date);
  return new Date(toInstant(date, 9 * 60, timeZone));
}
