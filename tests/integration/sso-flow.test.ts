import { afterAll, beforeAll, beforeEach, expect, test, vi } from 'vitest';
import type { SystemActor } from '@/db/with-actor';
import { addServer, disableServer } from '@/modules/hdu/api/servers';
import { startSmartupSignIn } from '@/modules/hdu/api/sso';
import { isSyntheticEmail } from '@/modules/hdu/util';
import { buildTestAuth, enrolledStaffFixture, newJar } from './helpers/auth';
import { RATE_RULES } from '@/modules/hdc/pref';
import { consumeRateLimit } from '@/modules/hdc/rate-limit';
import { ipRateKey } from '@/modules/hdc/util';
import { pools } from './helpers/db';
import { type MockServer, registerMock, requestWithServerCookie, ssoSignIn, startMockOidc } from './helpers/sso';

const system: SystemActor = { type: 'system', job: 'test' };
let mock: MockServer;
let dedicated: MockServer;
let third: MockServer;

beforeAll(async () => {
  mock = await startMockOidc('mock', 3290);
  dedicated = await startMockOidc('mock-dedicated', 3291);
  third = await startMockOidc('mock-third', 3292);
});
afterAll(async () => {
  await Promise.all([mock.stop(), dedicated.stop(), third.stop()]);
});
// Реестр очищается перед каждым тестом: серверы регистрируются заново.
beforeEach(async () => {
  await registerMock(mock, { isDefault: true, roleMap: { director: 'client_admin' } });
  await registerMock(dedicated);
});

const acme = (sub: string, extra: Record<string, unknown> = {}) => ({ sub, name: `Пользователь ${sub}`, company_id: '501', company_name: 'ACME Trade', ...extra });

test('вход без email создаёт пользователя со служебным адресом, организацию и членство', async () => {
  const s = await ssoSignIn(mock, acme('1001', { name: 'Алишер' }));
  expect(isSyntheticEmail(s.user.email)).toBe(true);
  expect(s.user.emailVerified).toBe(false);
  expect(s.user.name).toBe('Алишер');
  expect((await pools.root.query(`select "providerId", "accountId" from auth.account where "userId" = $1`, [s.user.id])).rows).toEqual([
    { providerId: 'mock', accountId: '1001' },
  ]);
  const org = (await pools.root.query(`select o.name, m.role, m.source from hdu_memberships m join hdu_organizations o using (org_id) where m.user_id = $1`, [s.user.id])).rows;
  expect(org).toEqual([{ name: 'ACME Trade', role: 'client_user', source: 'smartup' }]);
});

test('токены Smartup в базе не хранятся: порталу они не нужны (итоговая проверка, I5)', async () => {
  const a = await ssoSignIn(mock, acme('1001', { name: 'Алишер' }));
  await ssoSignIn(mock, acme('1001', { name: 'Алишер' }));
  const rows = (
    await pools.root.query(`select "accessToken", "refreshToken", "idToken" from auth.account where "userId" = $1 and "providerId" <> 'credential'`, [a.user.id])
  ).rows;
  expect(rows).toEqual([{ accessToken: null, refreshToken: null, idToken: null }]);
});

test('повторный вход того же человека не создаёт второго пользователя и обновляет имя', async () => {
  const a = await ssoSignIn(mock, acme('1001', { name: 'Алишер' }));
  const b = await ssoSignIn(mock, acme('1001', { name: 'Алишер Каримов' }));
  expect(b.user.id).toBe(a.user.id);
  expect(b.user.name).toBe('Алишер Каримов');
  expect((await pools.root.query(`select count(*)::int as n from auth.account where "providerId" = 'mock' and "accountId" = '1001'`)).rows[0].n).toBe(1);
});

test('одинаковый email у двух людей не объединяет учётные записи', async () => {
  const d = await ssoSignIn(mock, acme('1002', { name: 'Дильноза', email: 'dilnoza@acme.test', role: 'director' }));
  const t = await ssoSignIn(mock, { sub: '2001', name: 'Тимур', email: 'dilnoza@acme.test', company_id: '502', company_name: 'Globex' });
  expect(t.user.id).not.toBe(d.user.id);
  expect(isSyntheticEmail(d.user.email) && isSyntheticEmail(t.user.email)).toBe(true);
  expect(t.user.claimedEmail).toBe('dilnoza@acme.test');
  // Роль director по соответствию ролей сервера даёт администратора клиента.
  expect((await pools.root.query(`select role from hdu_memberships where user_id = $1`, [d.user.id])).rows).toEqual([{ role: 'client_admin' }]);
});

test('тот же идентификатор пользователя на другом сервере это другой человек и другая организация', async () => {
  const a = await ssoSignIn(mock, acme('1001'));
  const b = await ssoSignIn(dedicated, { sub: '1001', name: 'Алишер', company_id: '501', company_name: 'Initech' });
  expect(b.user.id).not.toBe(a.user.id);
  expect((await pools.root.query(`select count(*)::int as n from hdu_organizations where external_company_id = '501'`)).rows[0].n).toBe(2);
});

test('email сотрудника в сведениях Smartup не даёт прав сотрудника и не трогает его учётную запись', async () => {
  const { auth } = await buildTestAuth();
  const staff = await enrolledStaffFixture(auth, { role: 'admin' });
  const s = await ssoSignIn(mock, acme('4001', { email: staff.email }));
  expect(s.user.id).not.toBe(staff.userId);
  expect((await pools.root.query(`select 1 from hdu_staff where user_id = $1`, [s.user.id])).rowCount).toBe(0);
  expect((await pools.root.query(`select count(*)::int as n from auth.account where "userId" = $1`, [staff.userId])).rows[0].n).toBe(1);
});

test('пользователь без сведений о компании входит, но членства не получает', async () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const s = await ssoSignIn(mock, { sub: '3001', name: 'Без компании' });
  expect((await pools.root.query(`select 1 from hdu_memberships where user_id = $1`, [s.user.id])).rowCount).toBe(0);
  // Журнал называет поля без значений (проверка main, Q1).
  expect(warn).toHaveBeenCalledWith('Вход через Smartup без организации: причина no_company, сервер mock, поля companyId, companyName');
  warn.mockRestore();
});

test('неверная роль из Smartup не лишает организации (проверка main, Q1)', async () => {
  const s = await ssoSignIn(mock, acme('3002', { role: 'r'.repeat(500) }));
  expect((await pools.root.query(`select role from hdu_memberships where user_id = $1`, [s.user.id])).rows).toEqual([{ role: 'client_user' }]);
});

test('новый сервер в реестре принимает вход без перезапуска, отключённый перестаёт', async () => {
  await registerMock(third);
  await expect(ssoSignIn(third, acme('1'))).resolves.toHaveProperty('user');
  await disableServer(system, third.code);
  expect(await startSmartupSignIn({ locale: 'ru' }, requestWithServerCookie(third.code))).toEqual({ error: 'no_server' });
});

test('без запомненного сервера вход идёт через сервер по умолчанию, без сервера по умолчанию не начинается', async () => {
  const started = await startSmartupSignIn({ locale: 'ru' }, newJar().request);
  expect(started).toHaveProperty('url');
  expect(new URL((started as { url: string }).url).origin).toBe(mock.url);
  await pools.root.query(`update hdu_servers set is_default = false`);
  expect(await startSmartupSignIn({ locale: 'uz' }, newJar().request)).toEqual({ error: 'no_server' });
  expect(await startSmartupSignIn({ locale: 'ru' }, requestWithServerCookie('Bad Code'))).toEqual({ error: 'no_server' });
});

test('начало входа ставит куку состояния и просит PKCE', async () => {
  const jar = newJar();
  const started = (await startSmartupSignIn({ locale: 'ru', next: '/ru/tickets' }, jar.request)) as { url: string };
  const url = new URL(started.url);
  expect(url.searchParams.get('code_challenge_method')).toBe('S256');
  expect(url.searchParams.get('redirect_uri')).toBe('http://localhost:3000/api/auth/sso/callback/mock');
  expect(jar.cookie()).toMatch(/hub\.state=/);
});

test('после входа человек проходит шаг первого входа и попадает на запрошенную страницу, подменённый адрес не уводит с портала', async () => {
  for (const [next, expected] of [
    ['/ru/tickets', '/ru/tickets'],
    ['https://evil.example', '/ru'],
    ['//evil.example', '/ru'],
  ] as const) {
    mock.setNextClaims(acme('5001'));
    const jar = newJar({ cookie: 'hub_server=mock' });
    const started = (await startSmartupSignIn({ locale: 'ru', next }, jar.request)) as { url: string };
    const callback = (await fetch(started.url, { redirect: 'manual' })).headers.get('location') ?? '';
    const { handleAuthRequest } = await import('@/modules/hdu/api/auth-route');
    const response = await handleAuthRequest(new Request(callback, { headers: jar.request.headers }));
    // Сначала шаг первого входа (FR-ID-07), он сам пропускает дальше на безопасный адрес.
    const location = new URL(response.headers.get('location') ?? '', 'http://localhost:3000');
    expect(location.pathname, next).toBe('/ru/welcome');
    expect(location.searchParams.get('next'), next).toBe(expected);
    expect(location.origin, next).toBe('http://localhost:3000');
  }
});

test('сессия клиента живёт 30 дней', async () => {
  const s = await ssoSignIn(mock, acme('1001'));
  expect(Math.abs(s.session.expiresAt.getTime() - s.session.createdAt.getTime() - 30 * 24 * 3600 * 1000)).toBeLessThan(60_000);
});

test('адрес сервера, введённый клиентом, запоминается кукой, неизвестный адрес нет', async () => {
  const { rememberServer } = await import('@/modules/hdu/api/sso');
  const jar = newJar({ 'x-forwarded-for': '203.0.113.40' });
  expect(await rememberServer('localhost:3291', jar.request)).toEqual({ found: true });
  expect(jar.cookie()).toBe('hub_server=mock-dedicated');
  const other = newJar({ 'x-forwarded-for': '203.0.113.41' });
  expect(await rememberServer('unknown.smartup.example', other.request)).toEqual({ found: false });
  expect(other.cookie()).toBe('');
});

test('поиск сервера по адресу ограничен по частоте', async () => {
  const { rememberServer } = await import('@/modules/hdu/api/sso');
  const jar = newJar({ 'x-forwarded-for': '203.0.113.42' });
  for (let i = 0; i < 20; i++) await rememberServer('unknown.smartup.example', jar.request);
  expect(await rememberServer('localhost:3291', jar.request)).toEqual({ found: false, rateLimited: true });
});

test('начало входа ограничено по частоте для одного адреса', async () => {
  const request = newJar({ 'x-forwarded-for': '203.0.113.43' }).request;
  expect(await startSmartupSignIn({ locale: 'ru' }, request)).toHaveProperty('url');
  // Остаток предела расходуется напрямую: сотни настоящих начал входа тест не ускорят.
  const key = ipRateKey('sso-start:ip', request.headers);
  for (let i = 1; i < RATE_RULES.ssoStartPerIp.limit; i++) await consumeRateLimit(key, RATE_RULES.ssoStartPerIp);
  expect(await startSmartupSignIn({ locale: 'ru' }, request)).toEqual({ error: 'rate_limited' });
  // Соседний адрес той же сети IPv6 /64 считается тем же адресом (проверка main, S6).
  const v6 = newJar({ 'x-forwarded-for': '2001:db8:5:6::1' }).request;
  const v6key = ipRateKey('sso-start:ip', v6.headers);
  for (let i = 0; i < RATE_RULES.ssoStartPerIp.limit; i++) await consumeRateLimit(v6key, RATE_RULES.ssoStartPerIp);
  expect(await startSmartupSignIn({ locale: 'ru' }, newJar({ 'x-forwarded-for': '2001:db8:5:6:ffff::2' }).request)).toEqual({ error: 'rate_limited' });
});

test('Smartup не отвечает: вход не падает ошибкой сервера, а говорит, что сервер недоступен (итоговая проверка, I2)', async () => {
  // Сервер записан, но на его адресе никто не отвечает: документ discovery загрузить нельзя.
  await addServer(system, {
    code: 'down',
    name: 'Недоступный',
    baseUrl: 'http://localhost:3299',
    issuer: 'http://localhost:3299',
    clientId: 'hub',
    clientSecret: 'mock-client-secret',
  });
  expect(await startSmartupSignIn({ locale: 'ru' }, requestWithServerCookie('down'))).toEqual({ error: 'server_unavailable' });
});
