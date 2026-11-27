import { expect, test } from 'vitest';
import { checkPublicText } from '@/modules/hdp/util';

// Проверка публичного текста известной проблемы, рассылки и объявления (план M5c, решение 6; угроза T23). Те же
// правила, что у решений (телефоны, почта, ИНН, ПИНФЛ, длинные числа, ссылки вне разрешённых доменов), плюс названия
// и ИНН организаций привязанных обращений: сотрудник мог по привычке вставить название клиента.

const opts = { orgTerms: ['ACME Trade', '301234567'], allowedDomains: ['smartup.uz'] };
const kinds = (text: string, o = opts) => checkPublicText(text, o).map((f) => `${f.kind}:${f.text}`);

test('обычный текст без находок', () => {
  expect(kinds('После обновления 5.12.3 накладные не проводятся. Исправляем, обходной путь в решении.')).toEqual([]);
});

test('телефон, почта, ИНН и ПИНФЛ', () => {
  expect(kinds('Звоните +998 90 123-45-67 или пишите help@client.uz')).toEqual(['phone:+998 90 123-45-67', 'email:help@client.uz']);
  expect(kinds('ПИНФЛ 31234567890123')).toEqual(['pinfl:31234567890123']);
});

test('название и ИНН организации привязанного обращения без учёта регистра', () => {
  expect(kinds('У клиента acme trade накладные не проводятся')).toEqual(['org:acme trade']);
  expect(kinds('ИНН 301234567')).toEqual(['org:301234567']);
  // Короткие слова названия не находки: иначе любое "ООО" было бы названием клиента.
  expect(kinds('ООО и АО', { ...opts, orgTerms: ['ООО'] })).toEqual([]);
});

test('ссылка вне разрешённых доменов находка, ссылка портала и разрешённого домена нет', () => {
  expect(kinds('Подробнее https://evil.example/x')).toEqual(['link:evil.example']);
  expect(kinds('Подробнее https://help.smartup.uz/a/1 и /help/a/1001')).toEqual([]);
});
