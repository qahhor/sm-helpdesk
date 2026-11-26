import { afterEach, expect, test, vi } from 'vitest';
import { readSession } from '@/modules/hdu/api/request';
import { buildTestAuth, cookieOf, enrolledStaffFixture, staffHeaders, verifiedClientFixture } from './helpers/auth';
import { pools } from './helpers/db';

// Пределы сессии клиента (ASVS 5.0.0, 7.3.1 и 7.3.2; ответ владельца 26.11.2026, решение 0067):
// выход через 30 суток без активности и через 90 суток в любом случае. Часы подменены: только Date,
// таймеры и соединения с базой идут как обычно.

const DAY = 24 * 3600 * 1000;

afterEach(() => {
  vi.useRealTimers();
});

/** Клиент входит по ссылке в момент start. Куки сессии, как их запомнил бы браузер. */
async function signedInClient(email: string, start: number) {
  vi.useFakeTimers({ toFake: ['Date'], now: start });
  const built = await buildTestAuth();
  const client = await verifiedClientFixture(email);
  await built.auth.api.signInMagicLink({ body: { email: client.email }, headers: new Headers() });
  const verified = await built.auth.api.magicLinkVerify({ query: { token: built.lastToken() }, headers: new Headers(), returnHeaders: true });
  const headers = new Headers({ cookie: cookieOf(verified.headers) });
  return { ...built, client, headers };
}

const at = (time: number) => vi.setSystemTime(time);

async function sessionRows(userId: string) {
  return (await pools.root.query(`select "createdAt", "expiresAt" from auth.session where "userId" = $1`, [userId])).rows as {
    createdAt: Date;
    expiresAt: Date;
  }[];
}

test('сессия клиента без активности 30 суток не действует', async () => {
  const start = Date.UTC(2027, 0, 10, 9);
  const { auth, client, headers } = await signedInClient('idle@acme.test', start);
  at(start + 29 * DAY);
  expect((await auth.api.getSession({ headers }))?.user.id).toBe(client.userId);
  // Последняя активность на 29-е сутки продлила сессию: она действует ещё 30 суток от неё.
  at(start + 58 * DAY);
  expect((await auth.api.getSession({ headers }))?.user.id).toBe(client.userId);
  // Ещё 31 сутки без активности: выход.
  at(start + 89 * DAY + 2 * DAY);
  expect(await auth.api.getSession({ headers })).toBeNull();
});

test('сессия клиента без активности истекает через 30 суток и после одного входа', async () => {
  const start = Date.UTC(2027, 1, 1, 9);
  const { auth, headers } = await signedInClient('idle-once@acme.test', start);
  at(start + 30 * DAY + 60_000);
  expect(await auth.api.getSession({ headers })).toBeNull();
});

test('активность не продлевает сессию клиента дальше 90 суток от входа', async () => {
  const start = Date.UTC(2027, 2, 1, 9);
  const { auth, client, headers } = await signedInClient('absolute@acme.test', start);
  for (const day of [20, 40, 60, 80, 89]) {
    at(start + day * DAY);
    expect((await auth.api.getSession({ headers }))?.user.id, `сутки ${day}`).toBe(client.userId);
    const [row] = await sessionRows(client.userId);
    expect(new Date(row!.expiresAt).getTime(), `срок после продления на ${day}-е сутки`).toBeLessThanOrEqual(start + 90 * DAY + 1000);
  }
  at(start + 90 * DAY + 60_000);
  expect(await auth.api.getSession({ headers })).toBeNull();
});

test('сессия клиента старше 90 суток с дальним сроком в базе не действует и отзывается', async () => {
  // Сессия, продлённая до этого правила: срок в базе дальше предела. Портал проверяет время входа сам.
  const start = Date.UTC(2027, 3, 1, 9);
  const { client, headers } = await signedInClient('legacy@acme.test', start);
  await pools.root.query(`update auth.session set "expiresAt" = $1, "updatedAt" = $2 where "userId" = $3`, [
    new Date(start + 120 * DAY),
    new Date(start + 85 * DAY),
    client.userId,
  ]);
  at(start + 91 * DAY);
  expect(await readSession({ headers })).toBeNull();
  expect(await sessionRows(client.userId)).toEqual([]);
});

test('сессия сотрудника по-прежнему живёт 12 часов: предел клиента её не продлевает', async () => {
  const start = Date.UTC(2027, 4, 1, 9);
  vi.useFakeTimers({ toFake: ['Date'], now: start });
  const { auth } = await buildTestAuth();
  const staff = await enrolledStaffFixture(auth, { role: 'care' });
  const headers = await staffHeaders(auth, staff);
  const session = await auth.api.getSession({ headers });
  expect(new Date(session!.session.expiresAt).getTime() - start).toBeLessThanOrEqual(12 * 3600 * 1000 + 1000);
  at(start + 13 * 3600 * 1000);
  expect(await auth.api.getSession({ headers })).toBeNull();
});
