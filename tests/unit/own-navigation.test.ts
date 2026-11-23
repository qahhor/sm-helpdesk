import { expect, test } from 'vitest';
import { isOwnNavigation } from '@/modules/hdc/util';

// Запрос GET, который что-то меняет (код привязки Telegram), выполняется только по переходу самого человека
// со страницы портала или из адресной строки (аудит 23.11.2026, находки S13 и A5). Чужой сайт и предзагрузка нет.

const headers = (values: Record<string, string>) => new Headers(values);

test('переход со страницы портала и из адресной строки разрешён', () => {
  expect(isOwnNavigation(headers({ 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'navigate' }))).toBe(true);
  expect(isOwnNavigation(headers({ 'sec-fetch-site': 'none', 'sec-fetch-mode': 'navigate' }))).toBe(true);
  // Старый браузер без заголовков: чужой сайт не может заставить современный браузер их не слать.
  expect(isOwnNavigation(headers({}))).toBe(true);
});

test('запрос с чужого сайта и с соседнего поддомена отклоняется', () => {
  expect(isOwnNavigation(headers({ 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'navigate' }))).toBe(false);
  expect(isOwnNavigation(headers({ 'sec-fetch-site': 'same-site', 'sec-fetch-mode': 'navigate' }))).toBe(false);
  expect(isOwnNavigation(headers({ 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'no-cors', 'sec-fetch-dest': 'image' }))).toBe(false);
});

test('предзагрузка и запрос не переходом отклоняются даже со своей страницы', () => {
  expect(isOwnNavigation(headers({ 'sec-fetch-site': 'same-origin', 'sec-purpose': 'prefetch' }))).toBe(false);
  expect(isOwnNavigation(headers({ 'sec-fetch-site': 'same-origin', 'sec-purpose': 'prefetch;prerender' }))).toBe(false);
  expect(isOwnNavigation(headers({ 'sec-fetch-site': 'same-origin', purpose: 'prefetch' }))).toBe(false);
  expect(isOwnNavigation(headers({ 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'no-cors', 'sec-fetch-dest': 'image' }))).toBe(false);
  expect(isOwnNavigation(headers({ 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'cors' }))).toBe(false);
});
