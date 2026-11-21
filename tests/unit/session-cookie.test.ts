import { expect, test } from 'vitest';
import { sessionCookieRefresh } from '@/modules/hdu/api/session-cookie';

test('кука сессии на https продлевается на 30 дней с теми же байтами значения', () => {
  expect(sessionCookieRefresh('hub_locale=ru; __Host-hub.session_token=abc.d%2Bf%3D; other=1')).toBe(
    '__Host-hub.session_token=abc.d%2Bf%3D; Path=/; Max-Age=2592000; HttpOnly; SameSite=Lax; Secure',
  );
});

test('прежняя кука __Secure- библиотекой не читается и не продлевается (проверка main, S7)', () => {
  expect(sessionCookieRefresh('__Secure-hub.session_token=abc.def')).toBeNull();
});

test('кука сессии на http продлевается без Secure', () => {
  expect(sessionCookieRefresh('hub.session_token=abc.def')).toBe('hub.session_token=abc.def; Path=/; Max-Age=2592000; HttpOnly; SameSite=Lax');
});

test('без куки сессии ничего не ставится', () => {
  expect(sessionCookieRefresh(null)).toBeNull();
  expect(sessionCookieRefresh('hub_locale=ru; xhub.session_token=1')).toBeNull();
  expect(sessionCookieRefresh('hub.session_data=abc')).toBeNull();
});

test('значение с посторонними знаками не возвращается браузеру', () => {
  expect(sessionCookieRefresh('hub.session_token=a"b')).toBeNull();
  expect(sessionCookieRefresh('hub.session_token=')).toBeNull();
  expect(sessionCookieRefresh(`hub.session_token=${'a'.repeat(2000)}`)).toBeNull();
});
