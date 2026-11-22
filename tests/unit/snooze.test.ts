import { expect, test } from 'vitest';
import { snoozeTarget, zonedToDate } from '@/modules/hdt/sla';

// Быстрые варианты "Отложить" (UX-A-11) в часовом поясе поддержки, а не сервера.

const at = (local: string) => new Date(`${local.replace(' ', 'T')}:00+05:00`);

test('местное время Ташкента в момент, независимо от пояса процесса', () => {
  expect(zonedToDate('2026-11-24T09:00', 'Asia/Tashkent').toISOString()).toBe(at('2026-11-24 09:00').toISOString());
  expect(() => zonedToDate('2026-02-30T09:00', 'Asia/Tashkent')).toThrow();
  expect(() => zonedToDate('завтра', 'Asia/Tashkent')).toThrow();
});

test('через час, завтра в 09:00, в понедельник в 09:00', () => {
  const now = at('2026-11-27 16:20'); // пятница
  expect(snoozeTarget('hour', now, 'Asia/Tashkent').toISOString()).toBe(at('2026-11-27 17:20').toISOString());
  expect(snoozeTarget('tomorrow', now, 'Asia/Tashkent').toISOString()).toBe(at('2026-11-28 09:00').toISOString());
  expect(snoozeTarget('monday', now, 'Asia/Tashkent').toISOString()).toBe(at('2026-11-30 09:00').toISOString());
  // В понедельник "в понедельник" это следующий понедельник.
  expect(snoozeTarget('monday', at('2026-11-30 10:00'), 'Asia/Tashkent').toISOString()).toBe(at('2026-12-07 09:00').toISOString());
});
