import { afterAll, afterEach, beforeAll, beforeEach, expect, test, vi } from 'vitest';
import { setLogSinkForTests } from '@/lib/log';
import { handleAuthRequest } from '@/modules/hdu/api/auth-route';
import { requestEmailConfirmation } from '@/modules/hdu/api/email';
import { type ClientContext, resolveClient } from '@/modules/hdu/api/orgs';
import { readSession, type SessionData } from '@/modules/hdu/api/request';
import { FRESH_SIGN_IN_SEC, isFresh, resolveStaff, type StaffContext } from '@/modules/hdu/api/session';
import { revokeMySession, revokeOtherSessions } from '@/modules/hdu/api/sessions';
import { startSmartupSignIn } from '@/modules/hdu/api/sso';
import { isHduError } from '@/modules/hdu/error';
import { buildTestAuth, cookieOf, enrolledStaffFixture, newJar, reload, staffHeaders, verifiedClientFixture } from './helpers/auth';
import { pools } from './helpers/db';
import { memoryMailerPerTest } from './helpers/mail';
import { type MockServer, registerMock, ssoSignIn, startMockOidc } from './helpers/sso';

// Недавний вход считается от последней настоящей проверки личности в этой сессии, а не от создания сессии
// (решение 0083). Обычный вход через Smartup может пройти по открытой сессии Smartup Web без пароля, поэтому
// недавним не считается: смена адреса для входа и завершение других сессий просят "Войти заново".

const box = memoryMailerPerTest();
let mock: MockServer;
beforeAll(async () => {
  mock = await startMockOidc('mock', 3294);
});
afterAll(() => mock.stop());
beforeEach(async () => {
  mock.setIgnoresPrompt(false);
  mock.setOmitsAuthTime(false);
  await registerMock(mock, { isDefault: true });
});
afterEach(() => {
  vi.useRealTimers();
  setLogSinkForTests(null);
});

const claims = (sub: string) => ({ sub, name: 'Мадина', company_id: '501', company_name: 'ACME Trade' });
const clientOf = async (session: SessionData) => (await resolveClient(session)) as ClientContext;

async function freshAuthAt(sessionId: string): Promise<Date | null> {
  return (await pools.root.query(`select "freshAuthAt" from auth.session where id = $1`, [sessionId])).rows[0].freshAuthAt;
}

async function errorCode(run: () => Promise<unknown>): Promise<string | null> {
  try {
    await run();
    return null;
  } catch (error) {
    if (isHduError(error)) return error.code;
    throw error;
  }
}

test('обычный вход через Smartup не считается недавним: адрес и другие сессии просят войти заново', async () => {
  const session = await ssoSignIn(mock, claims('8101'));
  const other = await ssoSignIn(mock, claims('8101'));
  expect(await freshAuthAt(session.session.id)).toBeNull();
  expect(await requestEmailConfirmation(await clientOf(session), { email: 'madina@acme.test', locale: 'ru' })).toEqual({
    ok: false,
    code: 'stale_session',
  });
  expect(await errorCode(() => revokeMySession(session, other.session.id))).toBe('stale_session');
  expect(await errorCode(() => revokeOtherSessions(session))).toBe('stale_session');
  expect(await reload(other)).not.toBeNull();
  expect(box.mailer.sent).toEqual([]);
  // Выход завершением своей сессии по-прежнему не требует недавнего входа.
  expect(await revokeMySession(session, session.session.id)).toEqual({ signedOut: true });
});

test('после "Войти заново" через Smartup смена адреса и завершение других сессий доступны 15 минут', async () => {
  const before = Date.now();
  const other = await ssoSignIn(mock, claims('8102'));
  const session = await ssoSignIn(mock, claims('8102'), { reauth: true });
  const stamp = await freshAuthAt(session.session.id);
  expect(stamp?.getTime()).toBeGreaterThanOrEqual(before - 1000);
  expect(session.session.freshAuthAt?.getTime()).toBe(stamp?.getTime());
  expect(await requestEmailConfirmation(await clientOf(session), { email: 'madina2@acme.test', locale: 'ru' })).toEqual({ ok: true });
  expect(await revokeMySession(session, other.session.id)).toEqual({ signedOut: false });

  // Через 16 минут после нового входа окно закрыто, хотя сессия та же.
  await pools.root.query(`update auth.session set "freshAuthAt" = now() - interval '16 minutes' where id = $1`, [session.session.id]);
  const later = (await reload(session)) as SessionData;
  expect(await requestEmailConfirmation(await clientOf(later), { email: 'madina3@acme.test', locale: 'ru' })).toEqual({
    ok: false,
    code: 'stale_session',
  });
  expect(await errorCode(() => revokeOtherSessions(later))).toBe('stale_session');
});

test('вход заново без auth_time в ответе Smartup: вход недавний, событие auth.reauth_unverified в журнале', async () => {
  const events: string[] = [];
  setLogSinkForTests((_level, event) => void events.push(event));
  mock.setOmitsAuthTime(true);
  const session = await ssoSignIn(mock, claims('8103'), { reauth: true });
  expect(await freshAuthAt(session.session.id)).not.toBeNull();
  expect(events).toContain('auth.reauth_unverified');
});

test('брошенный вход заново не делает недавним следующий обычный вход: обычное начало убирает куку', async () => {
  mock.setNextClaims(claims('8104'));
  const jar = newJar({ cookie: `hub_server=${mock.code}`, 'x-forwarded-for': '203.0.113.31' });
  const abandoned = await startSmartupSignIn({ locale: 'ru', reauth: true }, jar.request);
  expect('url' in abandoned).toBe(true);
  expect(jar.cookie()).toMatch(/hub_reauth=/);
  const started = await startSmartupSignIn({ locale: 'ru' }, jar.request);
  if (!('url' in started)) throw new Error('Вход не начался');
  expect(jar.cookie()).not.toMatch(/hub_reauth=/);
  mock.setOmitsAuthTime(true);
  const callback = (await fetch(started.url, { redirect: 'manual' })).headers.get('location') as string;
  const response = await handleAuthRequest(new Request(callback, { headers: jar.request.headers }));
  expect(response.status).toBe(302);
  jar.request.setCookies(response.headers);
  const session = (await readSession(jar.request)) as SessionData;
  expect(await freshAuthAt(session.session.id)).toBeNull();
});

test('вход по ссылке из письма и из бота Telegram недавний; продление сессии время входа не сдвигает', async () => {
  const start = Date.UTC(2027, 5, 1, 9);
  vi.useFakeTimers({ toFake: ['Date'], now: start });
  const { auth, lastToken } = await buildTestAuth();
  const client = await verifiedClientFixture('fresh-link@acme.test');
  await auth.api.signInMagicLink({ body: { email: client.email }, headers: new Headers() });
  const verified = await auth.api.magicLinkVerify({ query: { token: lastToken() }, headers: new Headers(), returnHeaders: true });
  const headers = new Headers({ cookie: cookieOf(verified.headers) });
  const linkSession = await auth.api.getSession({ headers });
  expect((await freshAuthAt(linkSession!.session.id))?.getTime()).toBe(start);

  // Через двое суток библиотека продлевает сессию при активности: срок сдвигается, время входа нет.
  vi.setSystemTime(start + 2 * 24 * 3600 * 1000);
  await auth.api.getSession({ headers });
  const row = (await pools.root.query(`select "expiresAt", "freshAuthAt" from auth.session where id = $1`, [linkSession!.session.id])).rows[0];
  expect(new Date(row.expiresAt).getTime()).toBeGreaterThan(start + 30 * 24 * 3600 * 1000);
  expect(new Date(row.freshAuthAt).getTime()).toBe(start);

  const bot = await auth.api.signInTrusted({ body: { userId: client.userId, via: 'telegram' }, headers: new Headers(), returnHeaders: true });
  const botSession = await auth.api.getSession({ headers: new Headers({ cookie: cookieOf(bot.headers) }) });
  expect((await freshAuthAt(botSession!.session.id))?.getTime()).toBe(start + 2 * 24 * 3600 * 1000);
});

test('сотрудник: вход паролем с кодом недавний 15 минут, как раньше', async () => {
  const { auth } = await buildTestAuth();
  const staff = await enrolledStaffFixture(auth, { role: 'admin' });
  const headers = await staffHeaders(auth, staff);
  const session = await readSession({ headers });
  expect(session?.session.freshAuthAt).not.toBeNull();
  const ctx = (await resolveStaff(session, new Date())) as StaffContext;
  expect(isFresh(ctx, new Date(), FRESH_SIGN_IN_SEC)).toBe(true);
  expect(isFresh(ctx, new Date(ctx.freshAuthAt!.getTime() + 901_000), FRESH_SIGN_IN_SEC)).toBe(false);
});
