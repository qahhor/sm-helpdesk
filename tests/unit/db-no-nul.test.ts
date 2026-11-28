import { expect, test } from 'vitest';
import { withoutNul } from '@/db/no-nul';

// Нулевой байт в параметрах запроса убирается на границе базы (волна 7, S-T; решение 0157).

test('строки, списки и простые объекты очищаются, остальное не трогается', () => {
  expect(withoutNul('зак\u0000аз')).toBe('заказ');
  expect(withoutNul(['a\u0000', 1, null, ['b\u0000c']])).toEqual(['a', 1, null, ['bc']]);
  expect(withoutNul({ q: 'x\u0000', nested: { list: ['\u0000y'] } })).toEqual({ q: 'x', nested: { list: ['y'] } });
  const date = new Date(0);
  const buffer = Buffer.from([0, 1, 2]);
  expect(withoutNul(date)).toBe(date);
  expect(withoutNul(buffer)).toBe(buffer);
  // Значение без нулевых байтов возвращается тем же объектом: лишних копий нет.
  const clean = { a: ['b'] };
  expect(withoutNul(clean)).toBe(clean);
});
