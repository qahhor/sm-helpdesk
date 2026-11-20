import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import { botText } from '@/modules/hdn/api';
import { readSession } from '@/modules/hdu/api/request';
import { completeTelegramLogin, getBotLink, handleTelegramUpdate } from '@/modules/hdu/api/telegram';
import { newJar, noRequest } from './helpers/auth';
import { pools } from './helpers/db';
import { type MockServer, registerMock, ssoSignIn, startMockOidc } from './helpers/sso';
import { linkTelegramFixture, memoryBotPerTest, tgUpdate } from './helpers/telegram';
import { seedTwoOrgs } from './isolation/fixture';

// Запасной вход из Telegram (FR-ID-14, решение 94 ТЗ, угроза T30, сценарий 21 раздела 15.3).

const tg = memoryBotPerTest();
let mock: MockServer;
beforeAll(async () => {
  mock = await startMockOidc('mock', 3290);
});
afterAll(() => mock.stop());
beforeEach(() => registerMock(mock, { isDefault: true }));

const login = (from = 777001) => tgUpdate({ from, text: '/login' });
const tokenOf = (message: { linkButton?: { url: string } } | undefined) => new URL(message?.linkButton?.url ?? 'http://x/').searchParams.get('token') ?? '';
const loginLinks = () => tg.bot.sent.filter((m) => m.linkButton?.url.includes('/login/tg'));

test('пользователь без email входит по ссылке из бота, вход через Smartup и неподтверждённый адрес не тронуты', async () => {
  const s = await ssoSignIn(mock, { sub: '1001', name: 'Алишер', company_id: '501', company_name: 'ACME Trade' });
  await linkTelegramFixture({ userId: s.user.id }, 777001);
  const jar = newJar();
  await handleTelegramUpdate(login());
  const message = tg.bot.sent.at(-1);
  expect(message?.linkButton?.url).toMatch(/^http:\/\/localhost:3000\/ru\/login\/tg\?token=[\w-]{43}$/);
  expect(message?.text).toBe(botText('ru', 'loginLink', { minutes: '10' }));
  expect(await completeTelegramLogin({ token: tokenOf(message), locale: 'ru' }, jar.request)).toEqual({ ok: true, next: '/ru' });
  expect((await readSession(jar.request))?.user.id).toBe(s.user.id);
  expect((await pools.root.query(`select "emailVerified" from auth."user" where id = $1`, [s.user.id])).rows[0].emailVerified).toBe(false);
  expect((await pools.root.query(`select "providerId" from auth.account where "userId" = $1`, [s.user.id])).rows).toEqual([{ providerId: 'mock' }]);
});

test('кнопка "Войти" под сообщением о привязке тоже даёт ссылку', async () => {
  const f = await seedTwoOrgs();
  await linkTelegramFixture(f.aUser, 777001);
  await handleTelegramUpdate(tgUpdate({ from: 777001, callback: 'login' }));
  expect(loginLinks()).toHaveLength(1);
});

test('ссылка срабатывает один раз, живёт 10 минут, в базе лежит хешем', async () => {
  const f = await seedTwoOrgs();
  await linkTelegramFixture(f.aUser, 777001);
  await handleTelegramUpdate(login());
  const token = tokenOf(tg.bot.sent.at(-1));
  expect(JSON.stringify((await pools.root.query('select * from hdu_login_codes')).rows)).not.toContain(token);
  const ttl = (await pools.root.query(`select expires_on - created_on as ttl from hdu_login_codes`)).rows[0].ttl;
  expect(ttl).toMatchObject({ minutes: 10 });
  expect(await completeTelegramLogin({ token, locale: 'ru' }, noRequest)).toMatchObject({ ok: true });
  expect(await completeTelegramLogin({ token, locale: 'ru' }, noRequest)).toEqual({ ok: false, code: 'link_invalid' });
  await handleTelegramUpdate(login());
  const late = tokenOf(tg.bot.sent.at(-1));
  await pools.root.query(`update hdu_login_codes set expires_on = now() - interval '1 second' where used_on is null`);
  expect(await completeTelegramLogin({ token: late, locale: 'ru' }, noRequest)).toEqual({ ok: false, code: 'link_invalid' });
  for (const bad of ['', 'x', null, 'x'.repeat(500)]) expect(await completeTelegramLogin({ token: bad, locale: 'ru' }, noRequest)).toEqual({ ok: false, code: 'link_invalid' });
});

test('новый запрос отменяет прежнюю ссылку, язык ссылки берётся из учётной записи', async () => {
  const f = await seedTwoOrgs();
  await linkTelegramFixture(f.aUser, 777001);
  await handleTelegramUpdate(login());
  const first = tokenOf(tg.bot.sent.at(-1));
  await pools.root.query(`update auth."user" set locale = 'uz' where id = $1`, [f.aUser.userId]);
  await handleTelegramUpdate(login());
  expect(tg.bot.sent.at(-1)?.linkButton?.url).toContain('/uz/login/tg?token=');
  expect(await completeTelegramLogin({ token: first, locale: 'ru' }, noRequest)).toEqual({ ok: false, code: 'link_invalid' });
  expect(await completeTelegramLogin({ token: tokenOf(tg.bot.sent.at(-1)), locale: 'uz' }, noRequest)).toEqual({ ok: true, next: '/uz' });
});

test('шестой запрос ссылки за час ссылку не даёт', async () => {
  const f = await seedTwoOrgs();
  await linkTelegramFixture(f.aUser, 777001);
  for (let i = 0; i < 6; i++) await handleTelegramUpdate(login());
  expect(loginLinks()).toHaveLength(5);
  expect(tg.bot.sent.at(-1)?.text).toBe(botText('ru', 'loginTooOften', { minutes: '60' }));
});

test('непривязанный, заблокированный, лишённый членства и сотрудник ссылку не получают', async () => {
  const f = await seedTwoOrgs();
  await linkTelegramFixture(f.aUser, 777001);
  await linkTelegramFixture(f.bUser, 777002);
  await linkTelegramFixture(f.care, 777003);
  await pools.root.query(`update hdu_contact_identities set is_blocked = true where external_id = '777001'`);
  await pools.root.query(`update hdu_memberships set state = 'passive' where user_id = $1`, [f.bUser.userId]);
  for (const from of [777001, 777002, 777003, 999999]) await handleTelegramUpdate(login(from));
  expect(loginLinks()).toEqual([]);
  expect((await pools.root.query('select 1 from hdu_login_codes')).rowCount).toBe(0);
  expect(tg.bot.sent.find((m) => m.chatId === '999999')?.text).toBe(botText('ru', 'notLinked'));
  expect(tg.bot.sent.find((m) => m.chatId === '777002')?.text).toBe(botText('ru', 'loginNoAccess'));
});

test('гостевое членство входа не даёт', async () => {
  const f = await seedTwoOrgs();
  await linkTelegramFixture(f.aUser, 777001);
  await pools.root.query(`update hdu_memberships set source = 'guest' where user_id = $1`, [f.aUser.userId]);
  await handleTelegramUpdate(login());
  expect(loginLinks()).toEqual([]);
});

test('доступ, отозванный между запросом ссылки и нажатием, вход не даёт', async () => {
  const f = await seedTwoOrgs();
  await linkTelegramFixture(f.aUser, 777001);
  await handleTelegramUpdate(login());
  const token = tokenOf(tg.bot.sent.at(-1));
  await handleTelegramUpdate(tgUpdate({ from: 777001, text: '/unlink' }));
  expect(await completeTelegramLogin({ token, locale: 'ru' }, noRequest)).toEqual({ ok: false, code: 'link_invalid' });
  expect((await pools.root.query(`select 1 from auth.session where "userId" = $1`, [f.aUser.userId])).rowCount).toBe(0);
});

test('вход из бота записан в журнал аудита с адресом', async () => {
  const f = await seedTwoOrgs();
  await linkTelegramFixture(f.aUser, 777001);
  await handleTelegramUpdate(login());
  await completeTelegramLogin({ token: tokenOf(tg.bot.sent.at(-1)), locale: 'ru' }, { ...noRequest, headers: new Headers({ 'x-forwarded-for': '203.0.113.9' }) });
  expect((await pools.root.query(`select object_id, host(ip) as ip from hdc_audit_log where action = 'user.signed_in_telegram'`)).rows).toEqual([
    { object_id: f.aUser.userId, ip: '203.0.113.9' },
  ]);
});

test('адрес бота для страницы входа', async () => {
  expect(await getBotLink()).toBe('https://t.me/hub_test_bot');
});
