import { afterEach, expect, test } from 'vitest';
import type { SystemActor } from '@/db/with-actor';
import { getAuth } from '@/modules/hdu/auth/instance';
import { readSession } from '@/modules/hdu/api/request';
import { isFresh, resolveStaff, type StaffContext } from '@/modules/hdu/api/session';
import { acceptStaffInvitation, describeStaffInvitation, signInStaff, verifyStaffCode } from '@/modules/hdu/api/staff';
import { inviteStaff, resetStaff } from '@/modules/hdu/api/staff-admin';
import { hashToken } from '@/modules/hdu/tokens';
import { type BotCheck, type BotVerdict, setBotCheckForTests } from '@/security/bot-check';
import { freshTotp, totp } from '../helpers/totp';
import { clientSession, createStaffFixture, enrolledStaffFixture, newJar, noRequest, type StaffFixture } from './helpers/auth';
import { pools } from './helpers/db';
import { seedTwoOrgs } from './isolation/fixture';

const system: SystemActor = { type: 'system', job: 'test' };
const HOUR = 3600 * 1000;

/** Сотрудник через приглашение и принятие: пароль задан, второй фактор не подключён. */
async function acceptedStaff(role: 'care' | 'admin' | 'agent_l1' = 'care') {
  const email = `invited-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@smartup.example`;
  const password = 'correct-horse-12';
  const { token } = await inviteStaff(system, { email, name: 'Камила', role });
  await acceptStaffInvitation({ token, name: 'Камила', password });
  const userId = (await pools.root.query(`select id from auth."user" where email = $1`, [email])).rows[0].id as string;
  return { userId, email, password };
}

/** Полный вход функциями модуля: пароль, затем код. */
async function signInWithCode(staff: StaffFixture, jar = newJar()) {
  expect(await signInStaff({ email: staff.email, password: staff.password }, jar.request)).toEqual({ step: 'code' });
  expect(await verifyStaffCode({ code: freshTotp(staff.totpSecret) }, jar.request)).toEqual({ ok: true });
  return jar;
}

test('приглашение сотрудника живёт 24 часа, в базе только хеш', async () => {
  const { token, expiresOn } = await inviteStaff(system, { email: 'Care@Smartup.Example', name: 'Камила', role: 'care' });
  expect(expiresOn.getTime() - Date.now()).toBeGreaterThan(23.9 * HOUR);
  expect(expiresOn.getTime() - Date.now()).toBeLessThanOrEqual(24 * HOUR);
  const row = (await pools.root.query(`select * from hdu_invitations where email = 'care@smartup.example'`)).rows[0];
  expect(row.org_id).toBeNull();
  expect(row.role).toBe('care');
  expect(row.token_hash).toBe(hashToken(token));
  expect(JSON.stringify(row)).not.toContain(token);
  expect(await describeStaffInvitation(token)).toEqual({ email: 'care@smartup.example', name: 'Камила' });
  expect(await describeStaffInvitation('x'.repeat(43))).toBeNull();
  expect(await describeStaffInvitation('короткий')).toBeNull();
  const audit = (await pools.root.query(`select actor_type, diff from hdc_audit_log where action = 'staff.invited'`)).rows;
  expect(audit).toEqual([{ actor_type: 'system', diff: { role: 'care', isLead: false } }]);
  expect(JSON.stringify(audit)).not.toContain(token);
});

test('приглашать сотрудников может система и admin, но не care и не клиент', async () => {
  const f = await seedTwoOrgs();
  const input = (n: number) => ({ email: `x${n}@smartup.example`, name: 'x', role: 'agent_l1' });
  await expect(inviteStaff(f.care.actor, input(1))).rejects.toMatchObject({ code: 'forbidden' });
  await expect(inviteStaff(f.l1.actor, input(2))).rejects.toMatchObject({ code: 'forbidden' });
  await expect(inviteStaff(f.aAdmin.actor as never, input(3))).rejects.toMatchObject({ code: 'forbidden' });
  await expect(inviteStaff(f.adminStaff.actor, input(4))).resolves.toHaveProperty('token');
  expect((await pools.root.query(`select invited_by from hdu_invitations where email = 'x4@smartup.example'`)).rows[0].invited_by).toBe(
    f.adminStaff.userId,
  );
});

test('роль AI-сотрудника, роль клиента и неверный адрес в приглашении отклоняются', async () => {
  for (const bad of [
    { email: 'bot@smartup.example', name: 'x', role: 'agent_bot' },
    { email: 'c@smartup.example', name: 'x', role: 'client_admin' },
    { email: 'не адрес', name: 'x', role: 'care' },
    { email: 'c@smartup.example', name: '', role: 'care' },
    null,
  ])
    await expect(inviteStaff(system, bad)).rejects.toMatchObject({ code: 'invalid_input' });
  expect((await pools.root.query('select 1 from hdu_invitations')).rowCount).toBe(0);
});

test('принятие приглашения создаёт сотрудника, пароль и запись аудита одной транзакцией', async () => {
  const { token } = await inviteStaff(system, { email: 'l1@smartup.example', name: 'Азиз', role: 'agent_l1', isLead: true });
  await acceptStaffInvitation({ token, name: 'Азиз Каримов', password: 'correct-horse-12' });
  const user = (await pools.root.query(`select id, name, "emailVerified", "twoFactorEnabled" from auth."user" where email = 'l1@smartup.example'`)).rows[0];
  expect(user).toMatchObject({ name: 'Азиз Каримов', emailVerified: true });
  expect(user.twoFactorEnabled ?? false).toBe(false);
  expect((await pools.root.query(`select role, is_lead, state from hdu_staff where user_id = $1`, [user.id])).rows).toEqual([
    { role: 'agent_l1', is_lead: true, state: 'active' },
  ]);
  const account = (await pools.root.query(`select "providerId", "accountId", password from auth.account where "userId" = $1`, [user.id])).rows;
  expect(account).toHaveLength(1);
  expect(account[0]).toMatchObject({ providerId: 'credential', accountId: user.id });
  expect(account[0].password).not.toContain('correct-horse-12');
  expect((await pools.root.query(`select action from hdc_audit_log where object_id = $1`, [user.id])).rows.map((r) => r.action)).toContain(
    'staff.created',
  );
  await expect(acceptStaffInvitation({ token, name: 'x', password: 'correct-horse-12' })).rejects.toMatchObject({ code: 'link_invalid' });
});

test('просроченное и отозванное приглашение и короткий пароль отклоняются, пользователь не создаётся', async () => {
  const { token } = await inviteStaff(system, { email: 'late@smartup.example', name: 'x', role: 'care' });
  await expect(acceptStaffInvitation({ token, name: 'x', password: 'short' })).rejects.toMatchObject({ code: 'invalid_input' });
  await pools.root.query(`update hdu_invitations set expires_on = now() - interval '1 minute' where email = 'late@smartup.example'`);
  await expect(acceptStaffInvitation({ token, name: 'x', password: 'correct-horse-12' })).rejects.toMatchObject({ code: 'link_invalid' });
  const second = await inviteStaff(system, { email: 'late@smartup.example', name: 'x', role: 'care' });
  await pools.root.query(`update hdu_invitations set revoked_on = now() where token_hash = $1`, [hashToken(second.token)]);
  await expect(acceptStaffInvitation({ token: second.token, name: 'x', password: 'correct-horse-12' })).rejects.toMatchObject({
    code: 'link_invalid',
  });
  expect((await pools.root.query(`select 1 from auth."user" where email = 'late@smartup.example'`)).rowCount).toBe(0);
});

test('новое приглашение на тот же адрес отменяет прежнее', async () => {
  const first = await inviteStaff(system, { email: 'twice@smartup.example', name: 'x', role: 'care' });
  const second = await inviteStaff(system, { email: 'twice@smartup.example', name: 'x', role: 'admin' });
  await expect(acceptStaffInvitation({ token: first.token, name: 'x', password: 'correct-horse-12' })).rejects.toMatchObject({
    code: 'link_invalid',
  });
  await acceptStaffInvitation({ token: second.token, name: 'x', password: 'correct-horse-12' });
  expect((await pools.root.query(`select role from hdu_staff`)).rows).toEqual([{ role: 'admin' }]);
});

test('адрес клиента нельзя превратить в сотрудника', async () => {
  const f = await seedTwoOrgs();
  await pools.root.query(`update auth."user" set email = 'client@acme.example', "emailVerified" = true where id = $1`, [f.aUser.userId]);
  const { token } = await inviteStaff(system, { email: 'client@acme.example', name: 'x', role: 'admin' });
  await expect(acceptStaffInvitation({ token, name: 'x', password: 'correct-horse-12' })).rejects.toMatchObject({ code: 'email_taken' });
  expect((await pools.root.query(`select 1 from hdu_staff where user_id = $1`, [f.aUser.userId])).rowCount).toBe(0);
  expect((await pools.root.query(`select 1 from auth.account where "userId" = $1`, [f.aUser.userId])).rowCount).toBe(0);
});

test('первый вход по паролю начинает подключение второго фактора, рабочее место ещё закрыто', async () => {
  const staff = await acceptedStaff('care');
  const jar = newJar();
  const first = await signInStaff({ email: staff.email, password: staff.password }, jar.request);
  if (first.step !== 'enroll') throw new Error(`ожидался шаг подключения, получен ${first.step}`);
  expect(first.secret).toMatch(/^[A-Z2-7]{16,}$/);
  expect(first.qr.length).toBeGreaterThan(20);
  expect(first.qr.every((line) => line.length === first.qr.length)).toBe(true);
  expect(await resolveStaff(await readSession(jar.request), new Date())).toEqual({ denied: 'no_second_factor' });
  // Неверный код подключение не завершает.
  expect(await verifyStaffCode({ code: '000000' }, jar.request)).toEqual({ ok: false, code: 'code_invalid' });
  expect(await resolveStaff(await readSession(jar.request), new Date())).toEqual({ denied: 'no_second_factor' });
  expect(await verifyStaffCode({ code: totp(first.secret) }, jar.request)).toEqual({ ok: true });
  expect(await resolveStaff(await readSession(jar.request), new Date())).toMatchObject({
    actor: { type: 'staff', staffRole: 'care', userId: staff.userId },
    user: { email: staff.email, name: 'Камила' },
    isLead: false,
  });
});

test('сессия без кода не становится сессией сотрудника, когда второй фактор подключили в другом браузере (итоговая проверка, C1)', async () => {
  const staff = await acceptedStaff('admin');
  // Браузер A: только пароль, подключение не завершено.
  const a = newJar();
  expect((await signInStaff({ email: staff.email, password: staff.password }, a.request)).step).toBe('enroll');
  // Браузер B: пароль и подключение второго фактора.
  const b = newJar();
  const enroll = await signInStaff({ email: staff.email, password: staff.password }, b.request);
  if (enroll.step !== 'enroll') throw new Error(`ожидался шаг подключения, получен ${enroll.step}`);
  expect(await verifyStaffCode({ code: totp(enroll.secret) }, b.request)).toEqual({ ok: true });
  expect(await resolveStaff(await readSession(b.request), new Date())).toHaveProperty('actor');
  // Сессия A кода не предъявляла: после подключения в B она завершена (проверка main, S1).
  expect(await readSession(a.request)).toBeNull();
  // Любая сессия без отметки второго фактора рабочее место не открывает, даже если второй фактор подключён.
  const bare = await clientSession({ userId: staff.userId });
  expect(bare.session.secondFactorAt).toBeNull();
  expect(await resolveStaff(bare, new Date())).toEqual({ denied: 'no_second_factor' });
});

test('старая сессия одного пароля не даёт подбирать код и завершается; подключение второго фактора завершает остальные сессии (проверка main, S1)', async () => {
  const staff = await acceptedStaff('admin');
  const a = newJar();
  expect((await signInStaff({ email: staff.email, password: staff.password }, a.request)).step).toBe('enroll');
  const b = newJar();
  const enroll = await signInStaff({ email: staff.email, password: staff.password }, b.request);
  if (enroll.step !== 'enroll') throw new Error(`ожидался шаг подключения, получен ${enroll.step}`);
  expect(await verifyStaffCode({ code: totp(enroll.secret) }, b.request)).toEqual({ ok: true });
  // Сессия A после подключения в B завершена: подбирать код через неё нельзя.
  expect(await readSession(a.request)).toBeNull();
  expect(await verifyStaffCode({ code: '000000' }, a.request)).toEqual({ ok: false, code: 'sign_in_expired' });
  expect(await verifyStaffCode({ code: totp(enroll.secret) }, a.request)).toEqual({ ok: false, code: 'sign_in_expired' });
  // Сессия B, где второй фактор подключили, работает.
  expect(await resolveStaff(await readSession(b.request), new Date())).toHaveProperty('actor');
  const sessions = (await pools.root.query(`select 1 from auth.session where "userId" = $1`, [staff.userId])).rowCount;
  expect(sessions).toBe(1);
});

test('подбор кода при подключении второго фактора ограничен (проверка main, S1)', async () => {
  const staff = await acceptedStaff('care');
  const jar = newJar();
  expect((await signInStaff({ email: staff.email, password: staff.password }, jar.request)).step).toBe('enroll');
  const answers = [];
  for (let i = 0; i < 12; i++) answers.push((await verifyStaffCode({ code: '000000' }, jar.request)) as { code?: string });
  expect(answers.slice(0, 10).every((a) => a.code === 'code_invalid')).toBe(true);
  expect(answers.slice(10).map((a) => a.code)).toEqual(['code_locked', 'code_locked']);
});

test('вход с подключённым вторым фактором: пароль, затем код, запись в журнале с адресом', async () => {
  const staff = await enrolledStaffFixture(await getAuth(), { role: 'agent_l2' });
  const jar = newJar({ 'x-forwarded-for': '203.0.113.20', 'user-agent': 'Test/1.0' });
  expect(await signInStaff({ email: staff.email.toUpperCase(), password: staff.password }, jar.request)).toEqual({ step: 'code' });
  expect(await readSession(jar.request)).toBeNull(); // до кода сессии нет
  expect(await verifyStaffCode({ code: totp(staff.totpSecret) }, jar.request)).toEqual({ ok: true });
  const ctx = (await resolveStaff(await readSession(jar.request), new Date())) as StaffContext;
  expect(ctx.actor).toEqual({ type: 'staff', userId: staff.userId, staffRole: 'agent_l2' });
  const audit = (await pools.root.query(`select actor_type, actor_id, host(ip) as ip from hdc_audit_log where action = 'staff.signed_in'`)).rows;
  expect(audit).toEqual([{ actor_type: 'staff', actor_id: staff.userId, ip: '203.0.113.20' }]);
});

test('через 12 часов сессия сотрудника не действует и отзывается', async () => {
  const staff = await enrolledStaffFixture(await getAuth(), { role: 'care' });
  const jar = await signInWithCode(staff);
  const session = await readSession(jar.request);
  expect(await resolveStaff(session, new Date(Date.now() + 12 * HOUR - 60_000))).toHaveProperty('actor');
  expect(await resolveStaff(session, new Date(Date.now() + 12 * HOUR + 1000))).toEqual({ denied: 'expired' });
  expect((await pools.root.query(`select 1 from auth.session where id = $1`, [session!.session.id])).rowCount).toBe(0);
  expect(await readSession(jar.request)).toBeNull();
});

test('заблокированный сотрудник и сотрудник с чужой сессией теряют доступ на следующем запросе', async () => {
  const staff = await enrolledStaffFixture(await getAuth(), { role: 'agent_l2' });
  const jar = await signInWithCode(staff);
  await pools.root.query(`update hdu_staff set state = 'passive' where user_id = $1`, [staff.userId]);
  expect(await resolveStaff(await readSession(jar.request), new Date())).toEqual({ denied: 'not_staff' });
  await pools.root.query(`update hdu_staff set state = 'active' where user_id = $1`, [staff.userId]);
  await pools.root.query(`delete from auth.session where "userId" = $1`, [staff.userId]);
  expect(await resolveStaff(await readSession(jar.request), new Date())).toEqual({ denied: 'no_session' });
  expect(await resolveStaff(null, new Date())).toEqual({ denied: 'no_session' });
});

test('клиент не получает актора сотрудника', async () => {
  const f = await seedTwoOrgs();
  const auth = await getAuth();
  const signedIn = await auth.api.signInTrusted({
    body: { userId: f.aAdmin.userId, via: 'invitation' },
    headers: new Headers(),
    returnHeaders: true,
  });
  const jar = newJar();
  jar.request.setCookies(signedIn.headers);
  expect((await readSession(jar.request))?.user.id).toBe(f.aAdmin.userId);
  expect(await resolveStaff(await readSession(jar.request), new Date())).toEqual({ denied: 'not_staff' });
});

test('одиннадцатая попытка входа блокирует учётную запись на 15 минут, ответ одинаков для любого адреса', async () => {
  const staff = await enrolledStaffFixture(await getAuth(), { role: 'care' });
  for (const email of [staff.email, 'nobody@smartup.example']) {
    for (let i = 0; i < 10; i++)
      expect(await signInStaff({ email, password: 'wrong-password-1' }, noRequest)).toEqual({ step: 'error', code: 'invalid_credentials' });
    expect(await signInStaff({ email, password: 'wrong-password-1' }, noRequest)).toEqual({
      step: 'error',
      code: 'rate_limited',
      retryAfterSec: 900,
    });
  }
  expect(await signInStaff({ email: staff.email, password: staff.password }, noRequest)).toMatchObject({ code: 'rate_limited' });
});

test('успешный вход обнуляет счётчик попыток', async () => {
  const staff = await enrolledStaffFixture(await getAuth(), { role: 'care' });
  for (let i = 0; i < 9; i++) await signInStaff({ email: staff.email, password: 'wrong-password-1' }, noRequest);
  await signInWithCode(staff);
  for (let i = 0; i < 9; i++)
    expect(await signInStaff({ email: staff.email, password: 'wrong-password-1' }, noRequest)).toEqual({
      step: 'error',
      code: 'invalid_credentials',
    });
});

test('пять неверных кодов блокируют проверку кода, верный код после этого не проходит', async () => {
  const staff = await enrolledStaffFixture(await getAuth(), { role: 'care' });
  const jar = newJar();
  expect(await signInStaff({ email: staff.email, password: staff.password }, jar.request)).toEqual({ step: 'code' });
  for (let i = 0; i < 5; i++) expect(await verifyStaffCode({ code: '000000' }, jar.request)).toEqual({ ok: false, code: 'code_invalid' });
  expect(await verifyStaffCode({ code: totp(staff.totpSecret) }, jar.request)).toEqual({ ok: false, code: 'code_locked' });
  expect(await readSession(jar.request)).toBeNull();
});

test('код без шага пароля и неверный вид кода не проходят', async () => {
  expect(await verifyStaffCode({ code: '123456' }, noRequest)).toEqual({ ok: false, code: 'sign_in_expired' });
  expect(await verifyStaffCode({ code: '12345a' }, noRequest)).toEqual({ ok: false, code: 'invalid_input' });
  expect(await signInStaff({ email: 'не адрес', password: 'x' }, noRequest)).toEqual({ step: 'error', code: 'invalid_credentials' });
  expect(await signInStaff(null, noRequest)).toEqual({ step: 'error', code: 'invalid_credentials' });
});

test('принятый код второй раз не принимается, пока он ещё в окне (проверка main, S11)', async () => {
  const staff = await enrolledStaffFixture(await getAuth(), { role: 'care' });
  const code = freshTotp(staff.totpSecret);
  const first = newJar();
  expect(await signInStaff({ email: staff.email, password: staff.password }, first.request)).toEqual({ step: 'code' });
  expect(await verifyStaffCode({ code }, first.request)).toEqual({ ok: true });
  // Подсмотренный код и пароль: второй вход тем же кодом не открывает сессию.
  const second = newJar();
  expect(await signInStaff({ email: staff.email, password: staff.password }, second.request)).toEqual({ step: 'code' });
  expect(await verifyStaffCode({ code }, second.request)).toEqual({ ok: false, code: 'code_invalid' });
  expect(await readSession(second.request)).toBeNull();
  expect((await pools.root.query(`select count(*)::int as n from auth.session where "userId" = $1`, [staff.userId])).rows[0].n).toBe(1);
  // Код другого шага проходит.
  const third = newJar();
  expect(await signInStaff({ email: staff.email, password: staff.password }, third.request)).toEqual({ step: 'code' });
  expect(await verifyStaffCode({ code: freshTotp(staff.totpSecret) }, third.request)).toEqual({ ok: true });
});

test('повторный вход в том же браузере отзывает прежнюю сессию', async () => {
  const staff = await enrolledStaffFixture(await getAuth(), { role: 'care' });
  const jar = await signInWithCode(staff);
  const before = (await readSession(jar.request))!.session.id;
  await signInWithCode(staff, jar);
  const after = (await readSession(jar.request))!.session.id;
  expect(after).not.toBe(before);
  expect((await pools.root.query(`select 1 from auth.session where id = $1`, [before])).rowCount).toBe(0);
});

test('сброс сотрудника убирает пароль, второй фактор и все сессии', async () => {
  const staff = await enrolledStaffFixture(await getAuth(), { role: 'care' });
  await signInWithCode(staff);
  const { token } = await resetStaff(system, { email: staff.email });
  expect((await pools.root.query(`select 1 from auth.session where "userId" = $1`, [staff.userId])).rowCount).toBe(0);
  expect((await pools.root.query(`select 1 from auth."twoFactor" where "userId" = $1`, [staff.userId])).rowCount).toBe(0);
  expect((await pools.root.query(`select "twoFactorEnabled" from auth."user" where id = $1`, [staff.userId])).rows[0].twoFactorEnabled).toBe(false);
  expect(await signInStaff({ email: staff.email, password: staff.password }, noRequest)).toMatchObject({ code: 'invalid_credentials' });
  await acceptStaffInvitation({ token, name: 'Сотрудник', password: 'another-horse-34' });
  expect((await signInStaff({ email: staff.email, password: 'another-horse-34' }, newJar().request)).step).toBe('enroll');
  expect((await pools.root.query(`select role, state from hdu_staff where user_id = $1`, [staff.userId])).rows).toEqual([
    { role: 'care', state: 'active' },
  ]);
  expect((await pools.root.query(`select count(*)::int as n from auth."user" where email = $1`, [staff.email])).rows[0].n).toBe(1);
  expect((await pools.root.query(`select action from hdc_audit_log where object_id = $1`, [staff.userId])).rows.map((r) => r.action)).toContain(
    'staff.reset',
  );
});

test('сбросить можно только сотрудника, и делает это система или admin', async () => {
  const f = await seedTwoOrgs();
  const staff = await createStaffFixture({ role: 'agent_l1' });
  await expect(resetStaff(f.care.actor, { email: staff.email })).rejects.toMatchObject({ code: 'forbidden' });
  await expect(resetStaff(system, { email: 'nobody@smartup.example' })).rejects.toMatchObject({ code: 'not_found' });
  await expect(resetStaff(system, { email: 'не адрес' })).rejects.toMatchObject({ code: 'invalid_input' });
  await expect(resetStaff(f.adminStaff.actor, { email: staff.email })).resolves.toHaveProperty('token');
});

test('свежий вход: действие администратора доступно 15 минут после входа', async () => {
  const staff = await enrolledStaffFixture(await getAuth(), { role: 'care' });
  const jar = await signInWithCode(staff);
  const ctx = (await resolveStaff(await readSession(jar.request), new Date())) as StaffContext;
  expect(isFresh(ctx, new Date(), 900)).toBe(true);
  expect(isFresh(ctx, new Date(ctx.sessionCreatedAt.getTime() + 899_000), 900)).toBe(true);
  expect(isFresh(ctx, new Date(ctx.sessionCreatedAt.getTime() + 901_000), 900)).toBe(false);
});

// --- Проверка "не робот" на шаге пароля (задача 14, решение 0018) ---

const verdict = (v: BotVerdict): BotCheck => ({ enabled: true, verify: async () => v });
afterEach(() => setBotCheckForTests(null));

test('поток роботов не блокирует учётную запись сотрудника', async () => {
  const staff = await enrolledStaffFixture(await getAuth(), { role: 'care' });
  setBotCheckForTests(verdict('failed'));
  for (let i = 0; i < 20; i++)
    expect(await signInStaff({ email: staff.email, password: 'wrong-password-1', botToken: 'x' }, noRequest)).toEqual({ step: 'error', code: 'bot_check' });
  setBotCheckForTests(verdict('passed'));
  expect(await signInStaff({ email: staff.email, password: staff.password, botToken: 'ok' }, noRequest)).toEqual({ step: 'code' });
});

test('при недоступной проверке вход сотрудника идёт, счётчик попыток действует', async () => {
  const staff = await enrolledStaffFixture(await getAuth(), { role: 'care' });
  setBotCheckForTests(verdict('unavailable'));
  for (let i = 0; i < 10; i++) await signInStaff({ email: staff.email, password: 'wrong-password-1' }, noRequest);
  expect(await signInStaff({ email: staff.email, password: staff.password }, noRequest)).toMatchObject({ step: 'error', code: 'rate_limited' });
});

test('неудачный вход сотрудника и упор в счётчик записываются в журнал с адресом, чужой адрес не записывается (проверка main, S5)', async () => {
  const staff = await enrolledStaffFixture(await getAuth(), { role: 'care' });
  const jar = newJar({ 'x-forwarded-for': '203.0.113.31' });
  expect(await signInStaff({ email: staff.email, password: 'wrong-password-1' }, jar.request)).toMatchObject({ step: 'error', code: 'invalid_credentials' });
  expect(await signInStaff({ email: 'nobody@smartup.example', password: 'wrong-password-1' }, jar.request)).toMatchObject({ step: 'error' });
  const rows = (await pools.root.query(`select actor_type, object_id, diff, host(ip) as ip from hdc_audit_log where action = 'staff.sign_in_failed'`)).rows;
  expect(rows).toEqual([{ actor_type: 'system', object_id: staff.userId, diff: { step: 'password' }, ip: '203.0.113.31' }]);
  for (let i = 0; i < 20; i++) await signInStaff({ email: staff.email, password: 'wrong-password-1' }, jar.request);
  // Упор в счётчик пишется один раз за окно блокировки, а не на каждую попытку (итоговая проверка, замечание 3).
  const locked = (await pools.root.query(`select diff from hdc_audit_log where action = 'staff.sign_in_failed' and diff->>'step' = 'rate_limited'`)).rows;
  expect(locked).toHaveLength(1);
  // Общий счётчик для сигнала дежурным считает каждую неудачу известной учётной записи, без её адреса (план W0, задача 4).
  const counter = (await pools.root.query(`select hits from hdc_rate_limits where code = 'ops:staff-signin-failures'`)).rows;
  expect(counter).toEqual([{ hits: 21 }]);
});

test('неверный и повторный код второго фактора записываются в журнал с адресом (итоговая проверка, замечание 4)', async () => {
  const staff = await enrolledStaffFixture(await getAuth(), { role: 'care' });
  const code = freshTotp(staff.totpSecret);
  const first = newJar({ 'x-forwarded-for': '203.0.113.32' });
  expect(await signInStaff({ email: staff.email, password: staff.password }, first.request)).toEqual({ step: 'code' });
  expect(await verifyStaffCode({ code: '000000' }, first.request)).toEqual({ ok: false, code: 'code_invalid' });
  expect(await verifyStaffCode({ code }, first.request)).toEqual({ ok: true });
  const second = newJar({ 'x-forwarded-for': '203.0.113.33' });
  expect(await signInStaff({ email: staff.email, password: staff.password }, second.request)).toEqual({ step: 'code' });
  expect(await verifyStaffCode({ code }, second.request)).toEqual({ ok: false, code: 'code_invalid' });
  const rows = (
    await pools.root.query(`select object_id, diff, host(ip) as ip from hdc_audit_log where action = 'staff.sign_in_failed' order by created_on, audit_id`)
  ).rows;
  expect(rows).toEqual([
    { object_id: staff.userId, diff: { step: 'code' }, ip: '203.0.113.32' },
    { object_id: staff.userId, diff: { step: 'code_reused' }, ip: '203.0.113.33' },
  ]);
});

test('частый пароль при первом входе отклоняется, приглашение остаётся действующим (аудит, S11)', async () => {
  const { runCli } = await import('@/cli/commands');
  const lines: string[] = [];
  const io = { env: process.env, out: (line: string) => void lines.push(line), err: () => {}, readSecret: async () => '' };
  expect(await runCli(['staff:create', '--email', 'weak@smartup.example', '--name', 'Слабый', '--role', 'care'], io)).toBe(0);
  const token = (lines.find((line) => line.includes('token=')) ?? '').split('token=')[1] ?? '';
  const { acceptStaffInvitation } = await import('@/modules/hdu/api/staff');
  await expect(acceptStaffInvitation({ token, name: 'Слабый', password: 'Password12345' })).rejects.toMatchObject({ code: 'weak_password' });
  await expect(acceptStaffInvitation({ token, name: 'Слабый', password: 'qwertyuiop12' })).rejects.toMatchObject({ code: 'weak_password' });
  // Приглашение не потрачено: тот же токен принимает нормальный пароль.
  await acceptStaffInvitation({ token, name: 'Слабый', password: 'osh-palov-2-kishi-7Q' });
  expect((await pools.root.query(`select 1 from auth."user" where email = 'weak@smartup.example'`)).rowCount).toBe(1);
});
