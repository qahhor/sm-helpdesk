import { expect, test } from 'vitest';
import { cookieValue } from '@/lib/cookies';
import { firstParam } from '@/lib/search-params';

// Общие помощники вместо копий в каждой странице и модуле (проверка main, Q10).

test('первое значение параметра адреса', () => {
  expect(firstParam('a')).toBe('a');
  expect(firstParam(['a', 'b'])).toBe('a');
  expect(firstParam(undefined)).toBeUndefined();
  expect(firstParam([])).toBeUndefined();
});

test('значение куки по имени без раскодирования, похожее имя не подходит', () => {
  const header = 'hub_locale=ru; xhub_server=evil; hub_server=mock; t=a%2Bb=c';
  expect(cookieValue(header, 'hub_server')).toBe('mock');
  expect(cookieValue(header, 't')).toBe('a%2Bb=c');
  expect(cookieValue(header, 'nope')).toBeUndefined();
  expect(cookieValue(null, 'hub_server')).toBeUndefined();
});
