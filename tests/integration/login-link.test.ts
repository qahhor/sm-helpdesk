import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'vitest';
import { setMailerForTests } from '@/modules/hdn/api';
import { completeLoginLink, requestLoginLink } from '@/modules/hdu/api/login-link';
import { rememberServer } from '@/modules/hdu/api/sso';
import { type BotCheck, type BotVerdict, setBotCheckForTests } from '@/security/bot-check';
import { buildTestAuth, enrolledStaffFixture, noRequest, verifiedClientFixture } from './helpers/auth';
import { pools } from './helpers/db';
import { linkFrom, sleep, tokenFrom, memoryMailerPerTest } from './helpers/mail';
import { type MockServer, registerMock, ssoSignIn, startMockOidc } from './helpers/sso';

// Вход по ссылке на подтверждённый email (FR-ID-06, сценарий 2 раздела 15.3 ТЗ).

const box = memoryMailerPerTest();
let mock: MockServer;
beforeAll(async () => {
  mock = await startMockOidc('mock', 3290);
});
afterAll(() => mock.stop());
beforeEach(() => registerMock(mock, { isDefault: true }));
afterEach(() => setBotCheckForTests(null));

const verdict = (v: BotVerdict): BotCheck => ({ enabled: true, verify: async () => v });

test('подтверждённый клиент получает одно письмо со ссылкой на страницу портала', async () => {
  await verifiedClientFixture('anvar@acme.test');
  expect(await requestLoginLink({ email: 'Anvar@Acme.Test', locale: 'ru' }, noRequest)).toEqual({ ok: true });
  expect(box.mailer.sent).toHaveLength(1);
  expect(box.mailer.sent[0]).toMatchObject({ to: 'anvar@acme.test', kind: 'login-link' });
  expect(box.mailer.sent[0]?.text).toMatch(/http:\/\/localhost:3000\/ru\/login\/link\?token=[\w-]+/);
  expect(box.mailer.sent[0]?.text).not.toContain('/api/auth/');
});

test('неизвестный адрес, неподтверждённый адрес, сотрудник и участник без членства получают тот же ответ и ни одного письма', async () => {
  const { auth } = await buildTestAuth();
  const staff = await enrolledStaffFixture(auth, { role: 'care' });
  const sso = await ssoSignIn(mock, { sub: '1002', name: 'Дильноза', email: 'dilnoza@acme.test', company_id: '501', company_name: 'ACME Trade' });
  await verifiedClientFixture('lonely@acme.test', { memberships: 0 });
  for (const email of ['nobody@example.test', 'dilnoza@acme.test', staff.email, 'lonely@acme.test', sso.user.email, 'not-an-email'])
    expect(await requestLoginLink({ email, locale: 'ru' }, noRequest)).toEqual({ ok: true });
  expect(box.mailer.sent).toEqual([]);
});

test('отключённое членство и отключённая организация тоже не получают ссылку', async () => {
  const user = await verifiedClientFixture('anvar@acme.test');
  await pools.root.query(`update hdu_memberships set state = 'passive' where user_id = $1`, [user.userId]);
  await requestLoginLink({ email: 'anvar@acme.test', locale: 'ru' }, noRequest);
  expect(box.mailer.sent).toEqual([]);
});

test('ссылка срабатывает один раз и создаёт сессию клиента', async () => {
  const user = await verifiedClientFixture('anvar@acme.test');
  await requestLoginLink({ email: 'anvar@acme.test', locale: 'ru', next: '/ru/tickets' }, noRequest);
  const link = linkFrom(box.mailer.sent[0]);
  expect(link.searchParams.get('next')).toBe('/ru/tickets');
  const token = tokenFrom(box.mailer.sent[0]);
  expect(await completeLoginLink({ token, locale: 'ru', next: '/ru/tickets' }, noRequest)).toEqual({ ok: true, next: '/ru/tickets' });
  expect(await completeLoginLink({ token, locale: 'ru' }, noRequest)).toEqual({ ok: false, code: 'link_invalid' });
  expect((await pools.root.query(`select 1 from auth.session where "userId" = $1`, [user.userId])).rowCount).toBe(1);
});

test('ссылка на другом языке ведёт на страницу этого языка', async () => {
  await verifiedClientFixture('anvar@acme.test');
  await requestLoginLink({ email: 'anvar@acme.test', locale: 'uz' }, noRequest);
  expect(box.mailer.sent[0]?.text).toContain('http://localhost:3000/uz/login/link?token=');
});

test('через 15 минут ссылка не действует', async () => {
  await verifiedClientFixture('anvar@acme.test');
  await requestLoginLink({ email: 'anvar@acme.test', locale: 'ru' }, noRequest);
  await pools.root.query(`update auth.verification set "expiresAt" = now() - interval '1 second'`);
  expect(await completeLoginLink({ token: tokenFrom(box.mailer.sent[0]), locale: 'ru' }, noRequest)).toEqual({ ok: false, code: 'link_invalid' });
});

test('испорченный токен не принимается', async () => {
  for (const token of ['', 'abc', 'x'.repeat(500), '../../etc', null])
    expect(await completeLoginLink({ token, locale: 'ru' }, noRequest)).toEqual({ ok: false, code: 'link_invalid' });
});

test('токен ссылки не лежит в базе в открытом виде', async () => {
  await verifiedClientFixture('anvar@acme.test');
  await requestLoginLink({ email: 'anvar@acme.test', locale: 'ru' }, noRequest);
  expect(JSON.stringify((await pools.root.query('select * from auth.verification')).rows)).not.toContain(tokenFrom(box.mailer.sent[0]));
});

test('шестой запрос ссылки на адрес за час письма не даёт, ответ тот же', async () => {
  await verifiedClientFixture('anvar@acme.test');
  for (let i = 0; i < 6; i++) expect(await requestLoginLink({ email: 'anvar@acme.test', locale: 'ru' }, noRequest)).toEqual({ ok: true });
  expect(box.mailer.sent).toHaveLength(5);
});

test('двадцать первый запрос с одного IP за час письма не даёт', async () => {
  const request = { headers: new Headers({ 'x-forwarded-for': '203.0.113.50' }) };
  for (let i = 0; i < 21; i++) {
    await verifiedClientFixture(`u${i}@acme.test`);
    await requestLoginLink({ email: `u${i}@acme.test`, locale: 'ru' }, request);
  }
  expect(box.mailer.sent).toHaveLength(20);
});

test('ответ не ждёт отправки письма', async () => {
  await verifiedClientFixture('anvar@acme.test');
  setMailerForTests({ send: () => new Promise(() => {}) });
  await expect(
    Promise.race([requestLoginLink({ email: 'anvar@acme.test', locale: 'ru' }, noRequest), sleep(2000).then(() => 'timeout')]),
  ).resolves.toEqual({ ok: true });
});

test('сбой почты не ломает ответ формы', async () => {
  await verifiedClientFixture('anvar@acme.test');
  setMailerForTests({ send: () => Promise.reject(new Error('smtp down')) });
  expect(await requestLoginLink({ email: 'anvar@acme.test', locale: 'ru' }, noRequest)).toEqual({ ok: true });
});

test('подменённый адрес возврата в ссылке не уводит с портала', async () => {
  await verifiedClientFixture('anvar@acme.test');
  await requestLoginLink({ email: 'anvar@acme.test', locale: 'ru', next: 'https://evil.example' }, noRequest);
  expect(linkFrom(box.mailer.sent[0]).searchParams.get('next')).toBe('/ru');
  expect(await completeLoginLink({ token: tokenFrom(box.mailer.sent[0]), locale: 'ru', next: '//evil.example' }, noRequest)).toEqual({
    ok: true,
    next: '/ru',
  });
});

// --- Проверка "не робот" (задача 14, решение 0018) ---

test('запрос ссылки с непройденной проверкой письма не даёт, ответ тот же', async () => {
  await verifiedClientFixture('anvar@acme.test');
  setBotCheckForTests(verdict('failed'));
  expect(await requestLoginLink({ email: 'anvar@acme.test', locale: 'ru', botToken: 'x' }, noRequest)).toEqual({ ok: true });
  expect(box.mailer.sent).toEqual([]);
});

test('роботы не расходуют счётчик адреса: человек после них ссылку получает', async () => {
  await verifiedClientFixture('anvar@acme.test');
  setBotCheckForTests(verdict('failed'));
  for (let i = 0; i < 10; i++) await requestLoginLink({ email: 'anvar@acme.test', locale: 'ru', botToken: 'x' }, noRequest);
  setBotCheckForTests(verdict('passed'));
  await requestLoginLink({ email: 'anvar@acme.test', locale: 'ru', botToken: 'ok' }, noRequest);
  expect(box.mailer.sent).toHaveLength(1);
});

test('при недоступной проверке ссылка уходит, счётчик продолжает действовать', async () => {
  await verifiedClientFixture('anvar@acme.test');
  setBotCheckForTests(verdict('unavailable'));
  for (let i = 0; i < 6; i++) await requestLoginLink({ email: 'anvar@acme.test', locale: 'ru' }, noRequest);
  expect(box.mailer.sent).toHaveLength(5);
});

test('поиск сервера по адресу с непройденной проверкой ничего не находит', async () => {
  setBotCheckForTests(verdict('failed'));
  expect(await rememberServer('localhost:3290', noRequest, 'x')).toEqual({ found: false });
  setBotCheckForTests(verdict('passed'));
  expect(await rememberServer('localhost:3290', noRequest, 'x')).toEqual({ found: true });
});
