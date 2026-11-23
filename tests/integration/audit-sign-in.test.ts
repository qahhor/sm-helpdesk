import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import { acceptInvitation, inviteMember } from '@/modules/hdu/api/invitations';
import { completeLoginLink, requestLoginLink } from '@/modules/hdu/api/login-link';
import { completeTelegramLogin, handleTelegramUpdate } from '@/modules/hdu/api/telegram';
import { buildTestAuth, clientCtx, enrolledStaffFixture, noRequest, staffHeaders, verifiedClientFixture } from './helpers/auth';
import { pools } from './helpers/db';
import { memoryMailerPerTest, tokenFrom } from './helpers/mail';
import { type MockServer, registerMock, ssoSignIn, startMockOidc } from './helpers/sso';
import { linkTelegramFixture, memoryBotPerTest, tgUpdate } from './helpers/telegram';
import { seedTwoOrgs } from './isolation/fixture';

// Входы клиентов в журнале аудита (аудит 23.11.2026, находка S8): каждый способ входа оставляет запись
// user.signed_in со способом и адресом запроса. Вход сотрудника пишется отдельным действием staff.signed_in.

const box = memoryMailerPerTest();
const tg = memoryBotPerTest();
let mock: MockServer;
beforeAll(async () => {
  mock = await startMockOidc('mock', 3290);
});
afterAll(() => mock.stop());
beforeEach(() => registerMock(mock, { isDefault: true }));

const signIns = async () =>
  (await pools.root.query(`select actor_type, object_type, object_id, diff, host(ip) as ip from hdc_audit_log where action = 'user.signed_in' order by created_on`)).rows;
const from = (ip: string) => ({ ...noRequest, headers: new Headers({ 'x-forwarded-for': ip }) });

test('вход по ссылке на email записан со способом и адресом запроса', async () => {
  const user = await verifiedClientFixture('anvar@acme.test');
  await requestLoginLink({ email: 'anvar@acme.test', locale: 'ru' }, noRequest);
  expect(await completeLoginLink({ token: tokenFrom(box.mailer.sent[0]), locale: 'ru' }, from('203.0.113.9'))).toMatchObject({ ok: true });
  expect(await signIns()).toEqual([{ actor_type: 'system', object_type: 'user', object_id: user.userId, diff: { method: 'email_link' }, ip: '203.0.113.9' }]);
});

test('вход через сервер Smartup записан со способом smartup', async () => {
  const session = await ssoSignIn(mock, { sub: '1001', name: 'Алишер', company_id: '501', company_name: 'ACME Trade' });
  expect(await signIns()).toMatchObject([{ object_id: session.user.id, diff: { method: 'smartup' } }]);
});

test('вход по приглашению и вход из бота Telegram записаны своими способами', async () => {
  const f = await seedTwoOrgs();
  await inviteMember({ ctx: await clientCtx(f.aAdmin) }, { email: 'new@acme.test', role: 'client_user', locale: 'ru' });
  expect(await acceptInvitation({ token: tokenFrom(box.mailer.sent[0]), name: 'Новый Участник' }, noRequest)).toEqual({ ok: true });
  await linkTelegramFixture(f.aUser, 777001);
  await handleTelegramUpdate(tgUpdate({ from: 777001, text: '/login' }));
  const token = new URL(tg.bot.sent.at(-1)?.linkButton?.url ?? 'http://x/').searchParams.get('token') ?? '';
  expect(await completeTelegramLogin({ token, locale: 'ru' }, noRequest)).toMatchObject({ ok: true });
  expect((await signIns()).map((row) => row.diff)).toEqual([{ method: 'invitation' }, { method: 'telegram' }]);
});

test('вход сотрудника записью клиента не дублируется', async () => {
  const { auth } = await buildTestAuth();
  await staffHeaders(auth, await enrolledStaffFixture(auth, { role: 'care' }));
  expect(await signIns()).toEqual([]);
});

test('неудачная попытка входа записи не оставляет', async () => {
  await verifiedClientFixture('anvar@acme.test');
  expect(await completeLoginLink({ token: 'x'.repeat(32), locale: 'ru' }, noRequest)).toEqual({ ok: false, code: 'link_invalid' });
  expect(await signIns()).toEqual([]);
});
