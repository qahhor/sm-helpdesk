import { afterEach, expect, test, vi } from 'vitest';
import { addWorkingDays, addWorkingMinutes, type Calendar, TASHKENT_DEFAULT, workingMinutesBetween } from '@/modules/hdt/sla';

// Расчёт сроков по рабочему календарю (ТЗ, разделы 7.4 и 11.7; план M3, задача 1).
// Календарь: Пн-Пт 08:00-20:00, Сб 09:00-17:00, Вс выходной, Asia/Tashkent (UTC+5 без перехода на летнее время).

/** Местное время Ташкента 'YYYY-MM-DD HH:mm' как момент времени. */
const at = (local: string) => new Date(`${local.replace(' ', 'T')}:00+05:00`);

test.each([
  ['P2 создано в субботу в 16:30, первый ответ через 1 час', () => addWorkingMinutes(at('2026-11-21 16:30'), 60, TASHKENT_DEFAULT), '2026-11-23 08:30'],
  ['P1 создано в воскресенье в 03:00, срок ответа сотрудника 15 минут', () => addWorkingMinutes(at('2026-11-22 03:00'), 15, TASHKENT_DEFAULT), '2026-11-23 08:15'],
  ['P1 создано во вторник в 10:00, срок ответа сотрудника 15 минут', () => addWorkingMinutes(at('2026-11-24 10:00'), 15, TASHKENT_DEFAULT), '2026-11-24 10:15'],
  ['режим P1 "круглосуточно", создано в воскресенье в 03:00', () => addWorkingMinutes(at('2026-11-22 03:00'), 15, '24x7'), '2026-11-22 03:15'],
  ['P4 создано в пятницу в 10:00, решение через 5 рабочих дней', () => addWorkingDays(at('2026-11-27 10:00'), 5, TASHKENT_DEFAULT), '2026-12-03 10:00'],
  ['P3 создано во вторник в 21:00, первый ответ через 4 часа', () => addWorkingMinutes(at('2026-11-24 21:00'), 240, TASHKENT_DEFAULT), '2026-11-25 12:00'],
  ['P3 создано в пятницу в 15:00, решение через 2 рабочих дня (суббота рабочая)', () => addWorkingDays(at('2026-11-27 15:00'), 2, TASHKENT_DEFAULT), '2026-11-30 15:00'],
  ['P3 создано в четверг в 18:00, решение через 2 рабочих дня (вне субботнего графика к концу дня)', () => addWorkingDays(at('2026-11-26 18:00'), 2, TASHKENT_DEFAULT), '2026-11-28 17:00'],
  ['P2 создано в пятницу в 19:30, первый ответ через 1 час', () => addWorkingMinutes(at('2026-11-27 19:30'), 60, TASHKENT_DEFAULT), '2026-11-28 09:30'],
])('%s', (_name, run, expected) => {
  expect(run().toISOString()).toBe(at(expected).toISOString());
});

test('обращение стояло "Ждём клиента" 2 рабочих часа: срок решения сдвинут на 2 рабочих часа', () => {
  const due = addWorkingDays(at('2026-11-24 10:00'), 2, TASHKENT_DEFAULT); // P3: четверг 10:00
  const paused = workingMinutesBetween(at('2026-11-24 11:00'), at('2026-11-24 13:00'), TASHKENT_DEFAULT);
  expect(paused).toBe(120);
  expect(addWorkingMinutes(due, paused, TASHKENT_DEFAULT).toISOString()).toBe(at('2026-11-26 12:00').toISOString());
});

test('создано в праздничный день: отсчёт с начала следующего рабочего дня', () => {
  const withHoliday: Calendar = { ...(TASHKENT_DEFAULT as Exclude<Calendar, '24x7'>), holidays: ['2026-12-08'] };
  expect(addWorkingMinutes(at('2026-12-08 10:00'), 60, withHoliday).toISOString()).toBe(at('2026-12-09 09:00').toISOString());
  // Рабочие дни праздник тоже пропускают: вторник праздничный, пятница плюс 2 рабочих дня.
  expect(addWorkingDays(at('2026-12-05 10:00'), 2, withHoliday).toISOString()).toBe(at('2026-12-09 10:00').toISOString());
});

test('пауза через выходной и праздник считает только рабочие минуты', () => {
  const withHoliday: Calendar = { ...(TASHKENT_DEFAULT as Exclude<Calendar, '24x7'>), holidays: ['2026-11-30'] };
  // Суббота 16:00-17:00 (60), воскресенье выходной, понедельник праздник, вторник 08:00-09:00 (60).
  expect(workingMinutesBetween(at('2026-11-28 16:00'), at('2026-12-01 09:00'), withHoliday)).toBe(120);
  expect(workingMinutesBetween(at('2026-11-22 03:00'), at('2026-11-22 23:00'), TASHKENT_DEFAULT)).toBe(0);
  expect(workingMinutesBetween(at('2026-11-24 13:00'), at('2026-11-24 11:00'), TASHKENT_DEFAULT)).toBe(0);
  expect(workingMinutesBetween(at('2026-11-22 03:00'), at('2026-11-22 05:00'), '24x7')).toBe(120);
});

test('ноль минут и ноль дней не сдвигают срок; календарь без рабочих дней отклоняется', () => {
  expect(addWorkingMinutes(at('2026-11-24 10:00'), 0, TASHKENT_DEFAULT).toISOString()).toBe(at('2026-11-24 10:00').toISOString());
  const never: Calendar = { timeZone: 'Asia/Tashkent', week: { 0: null, 1: null, 2: null, 3: null, 4: null, 5: null, 6: null }, holidays: [] };
  expect(() => addWorkingMinutes(at('2026-11-24 10:00'), 15, never)).toThrow(/рабоч/);
});

const originalTz = process.env.TZ;
afterEach(() => {
  process.env.TZ = originalTz;
});

test('часовой пояс процесса не влияет на результат', () => {
  const run = () => [
    addWorkingMinutes(at('2026-11-21 16:30'), 60, TASHKENT_DEFAULT).toISOString(),
    addWorkingDays(at('2026-11-26 18:00'), 2, TASHKENT_DEFAULT).toISOString(),
    String(workingMinutesBetween(at('2026-11-28 16:00'), at('2026-12-01 09:00'), TASHKENT_DEFAULT)),
  ];
  process.env.TZ = 'UTC';
  const utc = run();
  process.env.TZ = 'America/New_York';
  expect(run()).toEqual(utc);
});

// Приёмка волны 1: на 200 тысячах обращений страницы очередей "Мои" и "Вторая линия" тратили около 50 мс в коде
// портала. Расчёт шёл по дням от создания обращения и на каждый день четыре раза форматировал дату.

test('рабочее время за 200 дней не форматирует дату на каждый день: границы рабочих дней запоминаются', () => {
  const from = at('2026-03-02 10:00');
  const to = at('2026-09-18 15:30');
  const expected = workingMinutesBetween(from, to, TASHKENT_DEFAULT);
  const spy = vi.spyOn(Intl.DateTimeFormat.prototype, 'formatToParts');
  try {
    // Тот же промежуток со сдвигом на минуту: дни те же, моменты другие.
    expect(workingMinutesBetween(new Date(from.getTime() + 60_000), to, TASHKENT_DEFAULT)).toBe(expected - 1);
    expect(spy.mock.calls.length).toBeLessThanOrEqual(8);
  } finally {
    spy.mockRestore();
  }
});

test('запоминание границ не путает часовые пояса и не ломает переход на летнее время', () => {
  const { week } = TASHKENT_DEFAULT;
  const berlin = { timeZone: 'Europe/Berlin', week, holidays: [] };
  const tashkent = { timeZone: 'Asia/Tashkent', week, holidays: [] };
  // Понедельник 30.03.2026, 08:00-20:00 местного: в Берлине уже летнее время (UTC+2), в Ташкенте UTC+5.
  const day = (cal: Calendar) => workingMinutesBetween(new Date('2026-03-29T00:00:00Z'), new Date('2026-03-31T00:00:00Z'), cal);
  expect(day(berlin)).toBe(day(berlin));
  expect(addWorkingMinutes(new Date('2026-03-29T00:00:00Z'), 1, berlin).toISOString()).toBe('2026-03-30T06:01:00.000Z');
  expect(addWorkingMinutes(new Date('2026-03-29T00:00:00Z'), 1, tashkent).toISOString()).toBe('2026-03-30T03:01:00.000Z');
  // Зимой Берлин на час позже по UTC.
  expect(addWorkingMinutes(new Date('2026-03-22T00:00:00Z'), 1, berlin).toISOString()).toBe('2026-03-23T07:01:00.000Z');
});

// Предел счёта (замер подготовки M9, задача 4): страница очереди сравнивает рабочее время срока с остатком и не
// должна проходить календарь за годы ради ответа "больше предела".
test('рабочие минуты с пределом: до предела как без него, после предела ровно предел', () => {
  const from = at('2024-11-25 08:00');
  const to = at('2026-11-25 12:00');
  const full = workingMinutesBetween(from, to, TASHKENT_DEFAULT);
  expect(full).toBeGreaterThan(100_000);
  for (const cap of [1, 59, 60, 61, 720, 5000, full - 1, full, full + 1]) expect(workingMinutesBetween(from, to, TASHKENT_DEFAULT, cap), String(cap)).toBe(Math.min(full, cap));
  expect(workingMinutesBetween(at('2026-11-23 08:00'), at('2026-11-23 09:30'), TASHKENT_DEFAULT, 1000)).toBe(90);
  expect(workingMinutesBetween(at('2026-11-23 08:00'), at('2026-11-23 09:30'), '24x7', 60)).toBe(60);
  // Без рабочего времени между моментами предел ничего не меняет.
  expect(workingMinutesBetween(at('2026-11-22 01:00'), at('2026-11-22 23:00'), TASHKENT_DEFAULT, 10)).toBe(0);
});
