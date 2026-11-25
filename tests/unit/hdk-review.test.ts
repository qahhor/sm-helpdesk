import { expect, test } from 'vitest';
import { needsReview, notHelpedPercent } from '@/modules/hdk/review';

// Список на пересмотр (FR-SOL-19; план M5, решение 18): доля "не помогло" выше 40% при не менее чем 10 исходах.

test('границы правила: 10 исходов и больше, строго выше 40%', () => {
  expect(needsReview({ helped: 5, notHelped: 5 })).toBe(true); // 10 исходов, 50%
  expect(needsReview({ helped: 6, notHelped: 4 })).toBe(false); // ровно 40% не выше порога
  expect(needsReview({ helped: 59, notHelped: 41 })).toBe(true); // 41%
  expect(needsReview({ helped: 0, notHelped: 9 })).toBe(false); // 9 исходов мало, даже при 100%
  expect(needsReview({ helped: 0, notHelped: 0 })).toBe(false);
  // Сравнение без округления: 666 из 1666 это 39,98%, 667 из 1667 уже 40,01%.
  expect(needsReview({ helped: 1_000, notHelped: 666 })).toBe(false);
  expect(needsReview({ helped: 1_000, notHelped: 667 })).toBe(true);
});

test('доля "не помогло" в процентах с одним знаком, без исходов пусто', () => {
  expect(notHelpedPercent({ helped: 6, notHelped: 4 })).toBe(40);
  expect(notHelpedPercent({ helped: 2, notHelped: 1 })).toBe(33.3);
  expect(notHelpedPercent({ helped: 0, notHelped: 0 })).toBeNull();
});
