import { describe, expect, test } from 'vitest';
import { cycleCountdown, workingDaysBetween } from '@/modules/hdi/util';

// Чистые функции модуля идей: обратный отсчёт до отбора месяца (строка доски "Отбор за ноябрь: осталось N дней", ТЗ 8.3)
// и рабочие дни для сводки модерации (план M7, решение 15).

describe('cycleCountdown', () => {
  test('середина ноября: отбор 1 декабря в 09:00 Ташкента (04:00 UTC), собирает ноябрь', () => {
    const r = cycleCountdown(new Date('2026-11-20T10:00:00Z'));
    expect(r.endsOn.toISOString()).toBe('2026-12-01T04:00:00.000Z');
    expect(r.month.getUTCMonth()).toBe(10);
    expect(r.daysLeft).toBe(11);
  });

  test('1 декабря до 09:00 Ташкента отбор ещё впереди, после 09:00 следующий в январе', () => {
    expect(cycleCountdown(new Date('2026-12-01T03:59:00Z'))).toMatchObject({ daysLeft: 1, endsOn: new Date('2026-12-01T04:00:00Z') });
    const after = cycleCountdown(new Date('2026-12-01T04:00:00Z'));
    expect(after.endsOn.toISOString()).toBe('2027-01-01T04:00:00.000Z');
    expect(after.month.getUTCMonth()).toBe(11);
  });
});

describe('workingDaysBetween', () => {
  test('выходные не считаются', () => {
    // Пятница 09:00 -> понедельник 09:00: один рабочий день.
    expect(workingDaysBetween(new Date('2026-11-20T04:00:00Z'), new Date('2026-11-23T04:00:00Z'))).toBe(1);
    // Понедельник -> среда: два.
    expect(workingDaysBetween(new Date('2026-11-23T04:00:00Z'), new Date('2026-11-25T04:00:00Z'))).toBe(2);
    expect(workingDaysBetween(new Date('2026-11-25T04:00:00Z'), new Date('2026-11-23T04:00:00Z'))).toBe(0);
  });
});
