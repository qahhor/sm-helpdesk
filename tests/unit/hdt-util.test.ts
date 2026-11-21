import { expect, test } from 'vitest';
import { formatNumber, parseNumber, titleFromDescription } from '@/modules/hdt/util';

test('тема из первого предложения описания', () => {
  expect(titleFromDescription('При сохранении заказа выходит ошибка: нет остатка на складе. Что делать?')).toBe(
    'При сохранении заказа выходит ошибка: нет остатка на складе',
  );
  expect(titleFromDescription('  Не грузится отчёт\nпо продажам  ')).toBe('Не грузится отчёт');
});

test('длинная тема режется по границе слова до 80 знаков', () => {
  const long = titleFromDescription(`${'слово '.repeat(40)}конец`);
  expect(long.length).toBeLessThanOrEqual(80);
  expect(long.endsWith('слово')).toBe(true);
  // Одно длинное слово режется по знакам, без половинок суррогатных пар.
  expect(Array.from(titleFromDescription('😀'.repeat(100))).length).toBe(80);
});

test('номер обращения SUP-<номер> пишется и разбирается', () => {
  expect(formatNumber(1042)).toBe('SUP-1042');
  expect([parseNumber('SUP-1042'), parseNumber('sup-1042'), parseNumber(' 1042 '), parseNumber('SUP-x'), parseNumber(''), parseNumber('-5')]).toEqual([
    1042,
    1042,
    1042,
    null,
    null,
    null,
  ]);
  expect(parseNumber('99999999999999999999')).toBeNull();
});
