import { expect, test } from 'vitest';
import { foldText } from '@/modules/hdc/search/fold';

// Свёртка написаний вместо soundex (план W6, решение 8): кириллица русского и узбекского в латиницу по одной схеме,
// апострофы узбекской латиницы убраны, похожие по звучанию буквы сведены.

test('узбекский: кириллица и латиница с апострофами сворачиваются в одно', () => {
  expect(foldText("to'lov o'tmayapti")).toBe('tolov otmayapti');
  expect(foldText('тўлов ўтмаяпти')).toBe('tolov otmayapti');
  expect(foldText('toʻlov oʻtmayapti')).toBe('tolov otmayapti');
  expect(foldText('to‘lov o‘tmayapti')).toBe('tolov otmayapti');
  expect(foldText('tolov otmayapti')).toBe('tolov otmayapti');
  expect(foldText("g'alla")).toBe(foldText('ғалла'));
});

test('x, h и kh дают h; q даёт k', () => {
  expect(foldText('xisobot')).toBe(foldText('hisobot'));
  expect(foldText('ҳисобот')).toBe('hisobot');
  expect(foldText('хисобот')).toBe('hisobot');
  expect(foldText('khisobot')).toBe('hisobot');
  expect(foldText('karz')).toBe(foldText('qarz'));
  expect(foldText('қарз')).toBe('karz');
});

test('русский латиницей находит русский кириллицей', () => {
  expect(foldText('накладная')).toBe(foldText('nakladnaya'));
  expect(foldText('Накладные')).toBe('nakladnie');
  expect(foldText('цена')).toBe(foldText('tsena'));
  expect(foldText('цена')).toBe('sena');
  expect(foldText('объём')).toBe('obem');
  expect(foldText('этаж')).toBe('etaj');
  expect(foldText('etazh')).toBe('etaj');
  expect(foldText('сыр')).toBe('sir');
});

test('двойные буквы в одну, регистр, знаки препинания и цифры', () => {
  expect(foldText('Касса')).toBe('kasa');
  expect(foldText('ОШИБКА 5.12, SUP-1042!')).toBe('oshibka 5 12 sup 1042');
  expect(foldText('  много   пробелов ')).toBe('mnogo probelov');
  expect(foldText('')).toBe('');
});

test('повторная свёртка ничего не меняет', () => {
  for (const sample of ["to'lov o'tmayapti", 'тўлов', 'xisobot', 'kkh', 'tss', 'zzh', 'щука', 'ЁЖ', 'Ц', 'ʻ', 'xxhq', 'накладная', 'kh h x', 'ttss'])
    expect(foldText(foldText(sample)), sample).toBe(foldText(sample));
});
