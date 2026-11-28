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

// Независимая проверка волны 7, находка R8: значение jsonb приходит от drizzle уже строкой JSON, знак в ней записан
// шестью знаками \u0000.
test('строка JSON: запись \\u0000 убирается, обратная косая черта перед обычным текстом остаётся', () => {
  expect(withoutNul(JSON.stringify({ text: 'зак\u0000аз', ['к\u0000люч']: ['\u0000', 'a\u0000\u0000b'] }))).toBe(JSON.stringify({ text: 'заказ', ключ: ['', 'ab'] }));
  // В тексте стоят сами знаки \u0000 (в JSON это \\u0000): это обычный текст, база его хранит.
  const literal = JSON.stringify({ text: String.raw`C:\u0000 и \\u0000` });
  expect(withoutNul(literal)).toBe(literal);
  // Косая черта, а за ней настоящий нулевой байт: черта остаётся, знак убирается.
  expect(withoutNul(JSON.stringify({ text: '\\\u0000' }))).toBe(JSON.stringify({ text: '\\' }));
  // Не JSON: шесть знаков в обычном тексте не трогаются.
  expect(withoutNul(String.raw`regexp \u0000 в описании`)).toBe(String.raw`regexp \u0000 в описании`);
  expect(withoutNul(String.raw`{не json \u0000`)).toBe(String.raw`{не json \u0000`);
});
