import { expect, test } from 'vitest';
import { isThanks } from '@/modules/hdt/core/thanks';

// Благодарность на решённое обращение (FR-TK-14, решение 15 плана M3): до 200 знаков, без вопроса и вопросительных
// слов, со словом благодарности. При любом сомнении обращение открывается заново.

test.each([
  ['Спасибо, всё работает!', true],
  ['спасибо большое', true],
  ['Благодарю за помощь', true],
  ['Помогло, спасибо 🙏', true],
  ['Все работает', true],
  ['Rahmat, ishladi', true],
  ['Raxmat!', true],
  ['Katta tashakkur', true],
  ['Рахмат, ишлади', true],
  ['Ташаккур', true],
  ['Thanks, works now', true],
  ['Thank you!', true],
  ['Спасибо, а как теперь выгрузить отчёт?', false],
  ['Спасибо, а как теперь выгрузить отчёт', false],
  ['Спасибо, но отчёт всё ещё не грузится', false],
  ['Спасибо. Не помогло', false],
  ['Rahmat, lekin yana xato chiqyapti', false],
  ['Rahmat, qanday qilib eksport qilaman', false],
  ['Rahmat, endi ishlaydimi', false],
  ['Рахмат, лекин яна хато', false],
  ['Thanks, but it still fails', false],
  ['Thanks! Why is the total different', false],
  ['Не работает', false],
  ['Ок', false],
  [`Спасибо! ${'Подробности про склад. '.repeat(12)}`, false],
])('%s -> %s', (text, expected) => {
  expect(isThanks(text)).toBe(expected);
});
