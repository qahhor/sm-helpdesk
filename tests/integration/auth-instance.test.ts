import { betterAuth } from 'better-auth';
import { getMigrations } from 'better-auth/db/migration';
import { Pool } from 'pg';
import { expect, test } from 'vitest';
import { buildAuthOptions } from '@/modules/hdu/auth/options';
import { getAuth, resetAuth } from '@/modules/hdu/auth/instance';
import { handleAuthRequest } from '@/modules/hdu/api/auth-route';
import { totp } from '../helpers/totp';
import {
  addServerFixture,
  buildTestAuth,
  createClientWithPasswordFixture,
  createStaffFixture,
  enrolledStaffFixture,
  passwordStep,
  staffHeaders,
  verifiedClientFixture,
} from './helpers/auth';
import { pools } from './helpers/db';

const HOUR = 3600 * 1000;

test('миграции схемы auth совпадают с тем, что ждёт библиотека', async () => {
  const { deps } = await buildTestAuth();
  const migrations = await getMigrations(buildAuthOptions(deps), { throwOnUnsafe: false });
  expect(migrations.toBeCreated.map((t) => t.table)).toEqual([]);
  expect(migrations.toBeAdded.map((t) => t.table)).toEqual([]);
  expect(await migrations.compileMigrations()).not.toMatch(/create table|alter table/i);
});

test('первый же вызов библиотеки проходит проверку схемы', async () => {
  const { auth } = await buildTestAuth();
  await expect(auth.api.getSession({ headers: new Headers() })).resolves.toBeNull();
});

test('куки сессии защищены на https, не привязаны к домену, кеша сессии в куке нет', async () => {
  const { deps } = await buildTestAuth();
  const prod = buildAuthOptions({ ...deps, baseUrl: 'https://hub.smartup24.com' });
  expect(prod.advanced).toMatchObject({ cookiePrefix: 'hub', useSecureCookies: true });
  expect(prod.advanced).not.toHaveProperty('crossSubDomainCookies');
  expect(prod.session).not.toHaveProperty('cookieCache');
  expect(buildAuthOptions({ ...deps, baseUrl: 'http://localhost:3000' }).advanced).toMatchObject({ useSecureCookies: false });
  expect(prod.rateLimit).toEqual({ enabled: false });
  expect(prod.account).toEqual({ accountLinking: { enabled: false } });
});

test('создание экземпляра не требует базы', async () => {
  const { deps } = await buildTestAuth();
  const dead = new Pool({ connectionString: 'postgres://hub_auth:x@127.0.0.1:1/none' });
  expect(() => betterAuth(buildAuthOptions({ ...deps, pool: dead }))).not.toThrow();
  await dead.end();
});

test('саморегистрация закрыта', async () => {
  const { auth } = await buildTestAuth();
  await expect(
    auth.api.signUpEmail({ body: { email: 'new@example.test', password: 'long-password-123', name: 'x' } }),
  ).rejects.toMatchObject({ body: { code: 'EMAIL_PASSWORD_SIGN_UP_DISABLED' } });
  expect((await pools.root.query(`select 1 from auth."user" where email = 'new@example.test'`)).rowCount).toBe(0);
});

test('сессия сотрудника живёт не дольше 12 часов и не продлевается', async () => {
  const { auth } = await buildTestAuth();
  const staff = await enrolledStaffFixture(auth, { role: 'care' });
  const headers = await staffHeaders(auth, staff);
  const first = await auth.api.getSession({ headers });
  expect(first?.user.id).toBe(staff.userId);
  const created = new Date(first!.session.createdAt).getTime();
  expect(new Date(first!.session.expiresAt).getTime() - created).toBeLessThanOrEqual(12 * HOUR + 1000);
  expect(new Date(first!.session.expiresAt).getTime() - created).toBeGreaterThan(11 * HOUR);
  // Библиотека продлевает сессию, когда с последнего обновления прошло больше суток.
  await pools.root.query(`update auth.session set "updatedAt" = now() - interval '2 days', "expiresAt" = now() + interval '1 hour' where id = $1`, [
    first!.session.id,
  ]);
  await auth.api.getSession({ headers });
  const row = (await pools.root.query(`select "expiresAt", "createdAt" from auth.session where id = $1`, [first!.session.id])).rows[0];
  expect(new Date(row.expiresAt).getTime()).toBeLessThanOrEqual(new Date(row.createdAt).getTime() + 12 * HOUR + 1000);
});

test('сессия клиента живёт 30 дней', async () => {
  const { auth, lastToken } = await buildTestAuth();
  const client = await verifiedClientFixture('thirty@acme.test');
  await auth.api.signInMagicLink({ body: { email: client.email }, headers: new Headers() });
  await auth.api.magicLinkVerify({ query: { token: lastToken() }, headers: new Headers() });
  const row = (await pools.root.query(`select "expiresAt" - "createdAt" as ttl from auth.session where "userId" = $1`, [client.userId])).rows[0];
  expect(row.ttl.days).toBe(30);
});

test('сотрудник не получает сессию по ссылке, его пароль остаётся на месте', async () => {
  const { auth, lastToken } = await buildTestAuth();
  const staff = await createStaffFixture({ role: 'admin' });
  await auth.api.signInMagicLink({ body: { email: staff.email }, headers: new Headers() });
  await expect(auth.api.magicLinkVerify({ query: { token: lastToken() }, headers: new Headers() })).rejects.toThrow();
  expect((await pools.root.query(`select 1 from auth.session where "userId" = $1`, [staff.userId])).rowCount).toBe(0);
  expect((await pools.root.query(`select 1 from auth.account where "userId" = $1 and password is not null`, [staff.userId])).rowCount).toBe(1);
});

test('заблокированный сотрудник и роль agent_bot не входят по паролю', async () => {
  const { auth } = await buildTestAuth();
  for (const patch of [{ state: 'passive' as const }, { role: 'agent_bot' as const }]) {
    const staff = await createStaffFixture({ role: 'care', ...patch });
    await expect(
      auth.api.signInEmail({ body: { email: staff.email, password: staff.password }, headers: new Headers() }),
    ).rejects.toThrow();
    expect((await pools.root.query(`select 1 from auth.session where "userId" = $1`, [staff.userId])).rowCount).toBe(0);
  }
});

test('пользователь без строки сотрудника не входит по паролю, даже если пароль у него есть', async () => {
  const { auth } = await buildTestAuth();
  const client = await createClientWithPasswordFixture();
  await expect(
    auth.api.signInEmail({ body: { email: client.email, password: client.password }, headers: new Headers() }),
  ).rejects.toThrow();
  expect((await pools.root.query(`select 1 from auth.session where "userId" = $1`, [client.userId])).rowCount).toBe(0);
});

test('закрытый вход недоступен снаружи и не выдаёт сессию сотруднику', async () => {
  const { auth } = await buildTestAuth();
  const client = await verifiedClientFixture('trusted@acme.test');
  const outside = await auth.handler(
    new Request('http://localhost:3000/api/auth/sign-in/trusted', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'http://localhost:3000' },
      body: JSON.stringify({ userId: client.userId, via: 'telegram' }),
    }),
  );
  expect(outside.status).toBe(404);
  expect((await pools.root.query(`select 1 from auth.session where "userId" = $1`, [client.userId])).rowCount).toBe(0);
  const staff = await createStaffFixture({ role: 'admin' });
  await expect(
    auth.api.signInTrusted({ body: { userId: staff.userId, via: 'telegram' }, headers: new Headers() }),
  ).rejects.toThrow();
  expect((await pools.root.query(`select 1 from auth.session where "userId" = $1`, [staff.userId])).rowCount).toBe(0);
  await expect(
    auth.api.signInTrusted({ body: { userId: client.userId, via: 'telegram' }, headers: new Headers() }),
  ).resolves.toMatchObject({ userId: client.userId });
  await expect(
    auth.api.signInTrusted({ body: { userId: client.userId, via: 'password' as never }, headers: new Headers() }),
  ).rejects.toThrow();
});

test('доверенное устройство выключено', async () => {
  const { auth } = await buildTestAuth();
  const staff = await enrolledStaffFixture(auth, { role: 'care' });
  const headers = await passwordStep(auth, staff);
  await expect(
    auth.api.verifyTOTP({ body: { code: totp(staff.totpSecret), trustDevice: true }, headers }),
  ).rejects.toThrow();
  await expect(auth.api.verifyTOTP({ body: { code: totp(staff.totpSecret) }, headers })).resolves.toBeDefined();
});

test('пять неверных кодов блокируют проверку второго фактора на 15 минут', async () => {
  const { auth } = await buildTestAuth();
  const staff = await enrolledStaffFixture(auth, { role: 'care' });
  const headers = await passwordStep(auth, staff);
  for (let i = 0; i < 5; i++)
    await expect(auth.api.verifyTOTP({ body: { code: '000000' }, headers })).rejects.toMatchObject({ body: { code: 'INVALID_CODE' } });
  await expect(auth.api.verifyTOTP({ body: { code: totp(staff.totpSecret) }, headers })).rejects.toMatchObject({
    body: { code: 'ACCOUNT_TEMPORARILY_LOCKED' },
  });
  const row = (await pools.root.query(`select "lockedUntil" - now() as left from auth."twoFactor" where "userId" = $1`, [staff.userId])).rows[0];
  expect(row.left.minutes).toBe(14);
});

test('у библиотеки открыт один адрес: возврат с сервера Smartup', async () => {
  const call = (method: string, path: string) =>
    handleAuthRequest(new Request(`http://localhost:3000${path}`, { method, headers: { 'x-forwarded-for': '203.0.113.5' } }));
  for (const [method, path] of [
    ['GET', '/api/auth/get-session'],
    ['POST', '/api/auth/sign-up/email'],
    ['POST', '/api/auth/sign-in/email'],
    ['POST', '/api/auth/sso/register'],
    ['GET', '/api/auth/list-sessions'],
    ['GET', '/api/auth/ok'],
  ] as const) {
    const response = await call(method, path);
    expect(response.status, path).toBe(404);
    expect(response.headers.get('content-type')).toBe('application/problem+json');
    expect(await response.json()).toEqual({ type: 'about:blank', title: 'Not Found', status: 404, code: 'not_found' });
  }
  // Разрешённый адрес доходит до библиотеки. Ошибку возврата (здесь чужое значение state)
  // показывает страница входа портала: страница ошибок библиотеки снаружи закрыта.
  const callback = await call('GET', '/api/auth/sso/callback/unknown-server?code=x&state=y');
  expect(callback.status).toBe(302);
  expect(callback.headers.get('location')).toMatch(/^http:\/\/localhost:3000\/login\?error=[a-z_]+/);
});

test('возврат с сервера ограничен по частоте', async () => {
  const call = () =>
    handleAuthRequest(
      new Request('http://localhost:3000/api/auth/sso/callback/unknown-server?code=x&state=y', {
        headers: { 'x-forwarded-for': '203.0.113.99' },
      }),
    );
  for (let i = 0; i < 60; i++) expect((await call()).status).not.toBe(429);
  const blocked = await call();
  expect(blocked.status).toBe(429);
  expect(Number(blocked.headers.get('retry-after'))).toBeGreaterThan(0);
});

test('изменение реестра серверов пересоздаёт экземпляр библиотеки', async () => {
  resetAuth();
  const before = await getAuth({ refresh: true });
  expect(await getAuth()).toBe(before);
  await addServerFixture({ code: 'added-later' });
  const after = await getAuth({ refresh: true });
  expect(after).not.toBe(before);
  expect(await getAuth({ refresh: true })).toBe(after);
});
