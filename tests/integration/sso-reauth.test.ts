import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import { type MockServer, registerMock, ssoSignIn, startMockOidc } from './helpers/sso';

// "Войти заново" через Smartup (ASVS 7.5; проверка подготовки M9, I1): запрос авторизации требует нового входа
// (prompt=login, max_age=0), а возврат с auth_time раньше начала этого входа отклоняется: сервер, который не выполнил
// требование, не выдаёт свежую сессию по открытой сессии Smartup Web.

let mock: MockServer;
beforeAll(async () => {
  mock = await startMockOidc('mock', 3293);
});
afterAll(() => mock.stop());
beforeEach(async () => {
  mock.setIgnoresPrompt(false);
  await registerMock(mock, { isDefault: true });
});

const claims = { sub: '7001', name: 'Мадина', company_id: '501', company_name: 'ACME Trade' };

test('вход заново просит у сервера новый вход и проходит, когда сервер его выполнил', async () => {
  const session = await ssoSignIn(mock, claims, { reauth: true });
  expect(session.user.name).toBe('Мадина');
  expect(mock.lastAuthorize().get('prompt')).toBe('login');
  expect(mock.lastAuthorize().get('max_age')).toBe('0');
});

test('сервер не выполнил новый вход (auth_time прежнего входа): возврат отклонён, сессии нет', async () => {
  mock.setIgnoresPrompt(true);
  await expect(ssoSignIn(mock, claims, { reauth: true })).rejects.toThrow(/Вход отклонён/);
});

test('обычный вход не просит нового входа и принимает прежнюю сессию Smartup', async () => {
  const session = await ssoSignIn(mock, claims);
  expect(session.user.name).toBe('Мадина');
  expect(mock.lastAuthorize().get('prompt')).toBeNull();
  expect(mock.lastAuthorize().get('max_age')).toBeNull();
});
