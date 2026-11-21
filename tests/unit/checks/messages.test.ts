import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';
import { checkCompleteness, checkIcu, checkWords } from '../../../scripts/checks/messages.mjs';
import { LOCALES } from '@/i18n/locales';

/** Строит вложенный объект по ключу с точками: nest('a.b', 1) даёт { a: { b: 1 } }. */
type Tree = { [key: string]: string | Tree };
const nest = (key: string, value: string): Tree =>
  key
    .split('.')
    .reverse()
    .reduce<string | Tree>((inner, part) => ({ [part]: inner }), value) as Tree;

test('полнота: ключ есть в ru и нет в uz', () => {
  expect(checkCompleteness({ ru: { a: 'x', b: 'y' }, uz: { a: 'x' }, en: { a: 'x', b: 'y' } })).toEqual([
    { locale: 'uz', key: 'b', problem: 'missing' },
  ]);
});

test('полнота: лишний ключ, которого нет в ru', () => {
  expect(checkCompleteness({ ru: { a: 'x' }, uz: { a: 'x', z: 'q' }, en: { a: 'x' } })).toEqual([
    { locale: 'uz', key: 'z', problem: 'extra' },
  ]);
});

test('полнота: вложенные ключи называются через точку, пустая строка считается пропуском', () => {
  expect(
    checkCompleteness({ ru: { client: { home: { title: 'x' } } }, uz: { client: { home: { title: ' ' } } }, en: {} }),
  ).toEqual([
    { locale: 'uz', key: 'client.home.title', problem: 'empty' },
    { locale: 'en', key: 'client.home.title', problem: 'missing' },
  ]);
});

test('ICU: сломанная строка и потерянная подстановка', () => {
  expect(
    checkIcu({
      ru: { a: '{n, plural, one {# день} few {# дня} many {# дней} other {# дня}}' },
      uz: { a: '{n, plural, one {# kun' },
      en: { a: 'days' },
    }),
  ).toEqual([
    { locale: 'uz', key: 'a', problem: 'icu-syntax' },
    { locale: 'en', key: 'a', problem: 'missing-argument:n' },
  ]);
});

test('ICU: подстановка внутри вариантов множественного числа учитывается', () => {
  expect(
    checkIcu({
      ru: { a: '{name}, у вас {n, plural, one {# обращение} other {# обращений}}' },
      uz: { a: '{name}, sizda {n, plural, one {# murojaat} other {# murojaat}}' },
      en: { a: 'You have {n, plural, one {# request} other {# requests}}' },
    }),
  ).toEqual([{ locale: 'en', key: 'a', problem: 'missing-argument:name' }]);
});

test.each([
  ['ru', 'client.x', 'Ваш тикет создан', 'forbidden:тикет'],
  ['ru', 'client.x', 'Список тикетов', 'forbidden:тикет'],
  ['ru', 'client.x', 'Обращение в очереди', 'forbidden:очеред'],
  ['ru', 'agent.x', 'Очередь первой линии', null],
  ['ru', 'common.x', 'Точно ответим сегодня', 'forbidden:точно'],
  ['ru', 'common.x', 'Точность расчёта', null],
  ['ru', 'agent.x', 'Новая заявка', 'forbidden:заявк'],
  ['ru', 'agent.x', 'Вопросы FAQ', 'forbidden:FAQ'],
  ['uz', 'client.x', 'Dala xodimlari', 'forbidden:dala'],
  ['uz', 'agent.x', 'dalada ishlash', 'forbidden:dala'],
  ['en', 'client.x', 'Smartup ERP support', 'forbidden:Smartup ERP'],
  ['en', 'client.x', 'Your ticket was created', 'forbidden:ticket'],
  ['en', 'agent.x', 'Ticket queue', null],
  ['ru', 'client.x', 'Запрос на обслуживание', null],
  ['ru', 'client.x', 'Специфический случай', null],
  ['ru', 'client.x', `Статус ${String.fromCharCode(0x2014)} открыт`, 'forbidden:U+2014'],
  // Клиент читает и страницы входа, и письма, и сообщения бота (проверка main, Q14).
  ['ru', 'auth.x', 'Ваше обращение в очереди', 'forbidden:очеред'],
  ['en', 'mail.x', 'Your ticket is ready', 'forbidden:ticket'],
  ['uz', 'bot.x', 'SLA muddati', 'forbidden:SLA'],
])('слова: %s %s "%s"', (locale, key, value, expected) => {
  const got = checkWords({ [locale]: nest(key, value) }).map((p) => p.problem);
  expect(got).toEqual(expected ? [expected] : []);
});

test('настоящие файлы сообщений проходят все три проверки', () => {
  const sources = Object.fromEntries(
    LOCALES.map((locale) => [locale, JSON.parse(readFileSync(`messages/${locale}.json`, 'utf8'))]),
  );
  expect(checkCompleteness(sources)).toEqual([]);
  expect(checkIcu(sources)).toEqual([]);
  expect(checkWords(sources)).toEqual([]);
});

test('ICU: лишняя подстановка, которой нет в русской строке (ревью I3)', () => {
  expect(checkIcu({ ru: { a: 'Привет, {name}' }, uz: { a: 'Salom, {name}, {count} ta' }, en: { a: 'Hello, {name}' } })).toEqual([
    { locale: 'uz', key: 'a', problem: 'extra-argument:count' },
  ]);
});
