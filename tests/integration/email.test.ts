import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import { completeWelcome, confirmEmail, requestEmailConfirmation } from '@/modules/hdu/api/email';
import { completeLoginLink, requestLoginLink } from '@/modules/hdu/api/login-link';
import { type ClientContext, resolveClient } from '@/modules/hdu/api/orgs';
import type { SessionData } from '@/modules/hdu/api/request';
import { noRequest } from './helpers/auth';
import { pools } from './helpers/db';
import { linkFrom, tokenFrom, memoryMailerPerTest } from './helpers/mail';
import { type MockServer, registerMock, ssoSignIn, startMockOidc } from './helpers/sso';

// Подтверждение адреса email (FR-ID-07): после него адрес становится адресом для входа по ссылке.

const box = memoryMailerPerTest();
let mock: MockServer;
beforeAll(async () => {
  mock = await startMockOidc('mock', 3290);
});
afterAll(() => mock.stop());
beforeEach(() => registerMock(mock, { isDefault: true }));

const acme = (sub: string, name: string, extra: Record<string, unknown> = {}) => ({ sub, name, company_id: '501', company_name: 'ACME Trade', ...extra });
const clientOf = async (session: SessionData) => (await resolveClient(session)) as ClientContext;

test('подтверждение адреса заменяет служебный адрес и сохраняет вход через Smartup', async () => {
  const s = await ssoSignIn(mock, acme('1002', 'Дильноза', { email: 'dilnoza@acme.test' }));
  const ctx = await clientOf(s);
  expect(ctx.user).toMatchObject({ email: null, claimedEmail: 'dilnoza@acme.test', hasVerifiedEmail: false });
  expect(await requestEmailConfirmation(ctx, { email: 'Dilnoza@Acme.Test', locale: 'ru' })).toEqual({ ok: true });
  expect(box.mailer.sent[0]).toMatchObject({ to: 'dilnoza@acme.test', kind: 'confirm-email' });
  expect(linkFrom(box.mailer.sent[0]).toString()).toMatch(/^http:\/\/localhost:3000\/ru\/confirm-email\?token=[\w-]{43}$/);
  expect(await confirmEmail({ token: tokenFrom(box.mailer.sent[0]) }, s, '203.0.113.72')).toEqual({ ok: true });
  expect((await pools.root.query(`select host(ip) as ip from hdc_audit_log where action = 'user.email_confirmed'`)).rows).toEqual([{ ip: '203.0.113.72' }]);
  expect((await pools.root.query(`select email, "emailVerified", "claimedEmail" from auth."user" where id = $1`, [s.user.id])).rows).toEqual([
    { email: 'dilnoza@acme.test', emailVerified: true, claimedEmail: null },
  ]);
  box.mailer.sent.length = 0;
  await requestLoginLink({ email: 'dilnoza@acme.test', locale: 'ru' }, noRequest);
  expect(await completeLoginLink({ token: tokenFrom(box.mailer.sent[0]), locale: 'ru' }, noRequest)).toEqual({ ok: true, next: '/ru' });
  expect((await pools.root.query(`select "providerId" from auth.account where "userId" = $1`, [s.user.id])).rows).toEqual([{ providerId: 'mock' }]);
  // Следующий вход через Smartup адрес не сбрасывает и не подставляет заново.
  const again = await ssoSignIn(mock, acme('1002', 'Дильноза', { email: 'other@acme.test' }));
  expect((await clientOf(again)).user).toMatchObject({ email: 'dilnoza@acme.test', claimedEmail: null, hasVerifiedEmail: true });
});

test('один подтверждённый адрес принадлежит одной учётной записи', async () => {
  const d = await ssoSignIn(mock, acme('1002', 'Дильноза'));
  const t = await ssoSignIn(mock, { sub: '2001', name: 'Тимур', company_id: '502', company_name: 'Globex' });
  for (const s of [d, t]) await requestEmailConfirmation(await clientOf(s), { email: 'shared@acme.test', locale: 'ru' });
  expect(await confirmEmail({ token: tokenFrom(box.mailer.sent[0]) }, d)).toEqual({ ok: true });
  expect(await confirmEmail({ token: tokenFrom(box.mailer.sent[1]) }, t)).toEqual({ ok: false, code: 'email_taken' });
  expect((await pools.root.query(`select "emailVerified" from auth."user" where id = $1`, [t.user.id])).rows[0].emailVerified).toBe(false);
});

test('адрес сотрудника клиент подтвердить не может', async () => {
  await pools.root.query(`insert into auth."user" (name, email, "emailVerified") values ('Сотрудник', 'kamila@smartup.example', true)`);
  const s = await ssoSignIn(mock, acme('1001', 'Алишер'));
  await requestEmailConfirmation(await clientOf(s), { email: 'kamila@smartup.example', locale: 'ru' });
  expect(await confirmEmail({ token: tokenFrom(box.mailer.sent[0]) }, s)).toEqual({ ok: false, code: 'email_taken' });
});

test('токен подтверждения одноразовый, живёт 60 минут, новый запрос отменяет прежний', async () => {
  const s = await ssoSignIn(mock, acme('1001', 'Алишер'));
  const ctx = await clientOf(s);
  await requestEmailConfirmation(ctx, { email: 'a1@acme.test', locale: 'ru' });
  await requestEmailConfirmation(ctx, { email: 'a2@acme.test', locale: 'ru' });
  await requestEmailConfirmation(ctx, { email: 'a3@acme.test', locale: 'ru' });
  expect(await confirmEmail({ token: tokenFrom(box.mailer.sent[0]) }, s)).toEqual({ ok: false, code: 'link_invalid' });
  const expires = (await pools.root.query(`select expires_on - created_on as ttl from hdu_email_tokens where email = 'a2@acme.test'`)).rows[0].ttl;
  expect(expires).toMatchObject({ hours: 1 });
  await pools.root.query(`update hdu_email_tokens set expires_on = now() - interval '1 second' where email = 'a3@acme.test'`);
  expect(await confirmEmail({ token: tokenFrom(box.mailer.sent[2]) }, s)).toEqual({ ok: false, code: 'link_invalid' });
  for (const token of ['', 'short', null, 'x'.repeat(500)]) expect(await confirmEmail({ token }, s)).toEqual({ ok: false, code: 'link_invalid' });
});

test('использованный токен второй раз не срабатывает', async () => {
  const s = await ssoSignIn(mock, acme('1001', 'Алишер'));
  await requestEmailConfirmation(await clientOf(s), { email: 'alisher@acme.test', locale: 'ru' });
  const token = tokenFrom(box.mailer.sent[0]);
  expect(await confirmEmail({ token }, s)).toEqual({ ok: true });
  expect(await confirmEmail({ token }, s)).toEqual({ ok: false, code: 'link_invalid' });
});

test('токен лежит в базе хешем', async () => {
  const s = await ssoSignIn(mock, acme('1001', 'Алишер'));
  await requestEmailConfirmation(await clientOf(s), { email: 'alisher@acme.test', locale: 'ru' });
  expect(JSON.stringify((await pools.root.query('select * from hdu_email_tokens')).rows)).not.toContain(tokenFrom(box.mailer.sent[0]));
});

test('подтверждение записано в журнал, сам адрес в журнал не попадает', async () => {
  const s = await ssoSignIn(mock, acme('1001', 'Алишер'));
  await requestEmailConfirmation(await clientOf(s), { email: 'alisher@acme.test', locale: 'ru' });
  await confirmEmail({ token: tokenFrom(box.mailer.sent[0]) }, s);
  const rows = (await pools.root.query(`select action, diff from hdc_audit_log where object_id = $1 and action = 'user.email_confirmed'`, [s.user.id])).rows;
  expect(rows).toHaveLength(1);
  expect(JSON.stringify(rows)).not.toContain('alisher@acme.test');
});

test('неверный адрес отклоняется, шестой запрос подтверждения за час тоже', async () => {
  const s = await ssoSignIn(mock, acme('1001', 'Алишер'));
  const ctx = await clientOf(s);
  expect(await requestEmailConfirmation(ctx, { email: 'not-an-email', locale: 'ru' })).toEqual({ ok: false, code: 'invalid_input' });
  for (let i = 0; i < 5; i++) expect(await requestEmailConfirmation(ctx, { email: `a${i}@acme.test`, locale: 'ru' })).toEqual({ ok: true });
  expect(await requestEmailConfirmation(ctx, { email: 'a6@acme.test', locale: 'ru' })).toEqual({ ok: false, code: 'rate_limited' });
  expect(box.mailer.sent).toHaveLength(5);
});

test('шаг первого входа отмечается один раз', async () => {
  const s = await ssoSignIn(mock, acme('1001', 'Алишер'));
  expect((await clientOf(s)).user.onboarded).toBe(false);
  await completeWelcome(s.user.id);
  const first = (await pools.root.query(`select "onboardedAt" from auth."user" where id = $1`, [s.user.id])).rows[0].onboardedAt;
  await completeWelcome(s.user.id);
  expect((await pools.root.query(`select "onboardedAt" from auth."user" where id = $1`, [s.user.id])).rows[0].onboardedAt).toEqual(first);
  const again = await ssoSignIn(mock, acme('1001', 'Алишер'));
  expect((await clientOf(again)).user.onboarded).toBe(true);
});

test('ссылку подтверждения тратит только вошедший владелец запроса: чужой адрес себе не присвоить (проверка main, S2)', async () => {
  const attacker = await ssoSignIn(mock, acme('1001', 'Алишер'));
  const victim = await ssoSignIn(mock, { sub: '2001', name: 'Тимур', company_id: '502', company_name: 'Globex' });
  await requestEmailConfirmation(await clientOf(attacker), { email: 'victim@globex.test', locale: 'ru' });
  const token = tokenFrom(box.mailer.sent[0]);
  // Владелец ящика открыл ссылку без входа или в своей учётной записи: адрес никому не привязывается, ссылка не тратится.
  expect(await confirmEmail({ token }, null)).toEqual({ ok: false, code: 'sign_in_required' });
  expect(await confirmEmail({ token }, victim)).toEqual({ ok: false, code: 'wrong_account' });
  expect((await pools.root.query(`select "emailVerified", email from auth."user" where id = $1`, [attacker.user.id])).rows[0].emailVerified).toBe(false);
  expect((await pools.root.query(`select used_on from hdu_email_tokens where email = 'victim@globex.test'`)).rows[0].used_on).toBeNull();
  // Владелец запроса в своей сессии подтверждает (так работает настоящий случай: ящик его).
  expect(await confirmEmail({ token }, attacker)).toEqual({ ok: true });
});
