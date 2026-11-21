import { expect, test } from 'vitest';
import type { StaffActor } from '@/db/with-actor';
import type { StaffRole } from '@/modules/hdu/pref';
import { createMailer, setMailerForTests } from '@/modules/hdn/mailer';
import { getAuth } from '@/modules/hdu/auth/instance';
import { readSession } from '@/modules/hdu/api/request';
import { resolveStaff, type StaffContext } from '@/modules/hdu/api/session';
import { acceptStaffInvitation, describeStaffInvitation, signInStaff, verifyStaffCode } from '@/modules/hdu/api/staff';
import { inviteStaff, resetStaff } from '@/modules/hdu/api/staff-admin';
import {
  changeStaffRole,
  inviteStaffByMail,
  listStaff,
  listStaffInvitations,
  resetStaffByMail,
  setStaffState,
} from '@/modules/hdu/api/staff-manage';
import { freshTotp, totp } from '../helpers/totp';
import { createStaffFixture, enrolledStaffFixture, newJar, noRequest, reload, type StaffFixture, staffCtx } from './helpers/auth';
import { pools } from './helpers/db';
import { memoryMailerPerTest, tokenFrom } from './helpers/mail';
import { seedTwoOrgs } from './isolation/fixture';

// Сотрудники в разделе "Настройки" (задача 19, FR-ADM-03): только admin со свежим входом, аудит в той же транзакции.

const box = memoryMailerPerTest();

const ctxOf = (staff: { userId: string }, role: StaffRole): StaffContext =>
  staffCtx({ userId: staff.userId, name: 'Администратор', actor: { type: 'staff', userId: staff.userId, staffRole: role } as StaffActor });

async function enrolled(role: StaffRole): Promise<StaffFixture> {
  return enrolledStaffFixture(await getAuth(), { role });
}

/** Полный вход сотрудника функциями модуля. Возвращает данные сессии. */
async function sessionOf(staff: StaffFixture) {
  const jar = newJar();
  expect(await signInStaff({ email: staff.email, password: staff.password }, jar.request)).toEqual({ step: 'code' });
  expect(await verifyStaffCode({ code: freshTotp(staff.totpSecret) }, jar.request)).toEqual({ ok: true });
  const session = await readSession({ headers: new Headers({ cookie: jar.cookie() }) });
  if (!session) throw new Error('Сессии нет');
  return session;
}

test('администратор приглашает сотрудника письмом, ссылка администратору не возвращается', async () => {
  const f = await seedTwoOrgs();
  const result = await inviteStaffByMail(staffCtx(f.adminStaff), { email: 'New-L2@smartup.example', name: 'Новый', role: 'agent_l2', locale: 'ru' });
  expect(result).toEqual({ mailSent: true });
  const mail = box.mailer.sent[0];
  expect(mail).toMatchObject({ to: 'new-l2@smartup.example', kind: 'staff-invitation' });
  expect(mail?.text).toMatch(new RegExp(`${process.env.HUB_URL}/ru/staff/setup\\?token=[\\w-]{43}`));
  expect(await describeStaffInvitation(tokenFrom(mail))).toEqual({ email: 'new-l2@smartup.example', name: 'Новый' });
  const audit = (await pools.root.query(`select actor_id from hdc_audit_log where action = 'staff.invited'`)).rows;
  expect(audit).toEqual([{ actor_id: f.adminStaff.userId }]);
  expect(await listStaffInvitations(staffCtx(f.adminStaff))).toMatchObject([{ email: 'new-l2@smartup.example', role: 'agent_l2' }]);
  // Принятое приглашение из списка ждущих уходит.
  await acceptStaffInvitation({ token: tokenFrom(mail), name: 'Новый', password: 'correct-horse-12' });
  expect(await listStaffInvitations(staffCtx(f.adminStaff))).toEqual([]);
});

test('без почты приглашение создаётся, а страница узнаёт, что письмо не ушло', async () => {
  const f = await seedTwoOrgs();
  setMailerForTests(createMailer({ MAIL_TRANSPORT: 'none' }));
  expect(await inviteStaffByMail(staffCtx(f.adminStaff), { email: 'x@smartup.example', name: 'x', role: 'care', locale: 'ru' })).toEqual({ mailSent: false });
  expect((await pools.root.query(`select 1 from hdu_invitations where email = 'x@smartup.example'`)).rowCount).toBe(1);
});

test('блокировка закрывает доступ сразу и завершает сессии', async () => {
  const f = await seedTwoOrgs();
  const target = await enrolled('agent_l1');
  const session = await sessionOf(target);
  await setStaffState(staffCtx(f.adminStaff), { userId: target.userId, state: 'passive' });
  expect((await pools.root.query(`select 1 from auth.session where "userId" = $1`, [target.userId])).rowCount).toBe(0);
  expect(await resolveStaff(await reload(session), new Date())).toEqual({ denied: 'no_session' });
  expect(await signInStaff({ email: target.email, password: target.password }, noRequest)).toMatchObject({ step: 'error', code: 'invalid_credentials' });
  const audit = (await pools.root.query(`select actor_id, object_id, diff from hdc_audit_log where action = 'staff.state_changed'`)).rows;
  expect(audit).toEqual([{ actor_id: f.adminStaff.userId, object_id: target.userId, diff: { from: 'active', to: 'passive' } }]);
  // Снова включённый сотрудник входит как раньше.
  await setStaffState(staffCtx(f.adminStaff), { userId: target.userId, state: 'active' });
  await sessionOf(target);
});

test('себя нельзя заблокировать и понизить, последнего администратора тоже', async () => {
  const only = await enrolled('admin');
  const ctx = ctxOf(only, 'admin');
  await expect(setStaffState(ctx, { userId: only.userId, state: 'passive' })).rejects.toMatchObject({ code: 'forbidden' });
  await expect(changeStaffRole(ctx, { userId: only.userId, role: 'care' })).rejects.toMatchObject({ code: 'forbidden' });
  await expect(resetStaffByMail(ctx, { userId: only.userId, locale: 'ru' })).rejects.toMatchObject({ code: 'forbidden' });
  const second = await enrolled('admin');
  // Второго можно: первый остаётся действующим администратором.
  await setStaffState(ctx, { userId: second.userId, state: 'passive' });
  await pools.root.query(`update hdu_staff set state = 'active' where user_id = $1`, [second.userId]);
  await changeStaffRole(ctxOf(second, 'admin'), { userId: only.userId, role: 'care' });
  await expect(changeStaffRole(ctxOf(second, 'admin'), { userId: second.userId, role: 'care' })).rejects.toMatchObject({ code: 'forbidden' });
  // Заблокированный администратор действующим не считается.
  const third = await enrolled('admin');
  await pools.root.query(`update hdu_staff set state = 'passive' where user_id = $1`, [third.userId]);
  await pools.root.query(`update hdu_staff set role = 'admin' where user_id = $1`, [only.userId]);
  await setStaffState(ctxOf(second, 'admin'), { userId: only.userId, state: 'passive' });
  await expect(changeStaffRole(ctxOf(second, 'admin'), { userId: third.userId, role: 'care' })).resolves.toBeUndefined();
});

test('изменение, после которого не останется администратора, отклоняется своим кодом (проверка main, Q5)', async () => {
  const x = await enrolled('admin');
  const y = await enrolled('admin');
  // Пока шёл запрос Y, его самого заблокировали: действующий администратор остался один, X.
  await pools.root.query(`update hdu_staff set state = 'passive' where user_id = $1`, [y.userId]);
  await expect(changeStaffRole(ctxOf(y, 'admin'), { userId: x.userId, role: 'care' })).rejects.toMatchObject({ code: 'last_admin' });
  await expect(setStaffState(ctxOf(y, 'admin'), { userId: x.userId, state: 'passive' })).rejects.toMatchObject({ code: 'last_admin' });
});

test('роль меняет только admin со свежим входом, роль agent_bot не выдаётся', async () => {
  const f = await seedTwoOrgs();
  const target = await enrolled('agent_l1');
  const ctx = staffCtx(f.adminStaff);
  await expect(changeStaffRole(staffCtx(f.care), { userId: target.userId, role: 'agent_l2' })).rejects.toMatchObject({ code: 'forbidden' });
  await expect(changeStaffRole(ctx, { userId: target.userId, role: 'agent_l2' }, new Date(+ctx.sessionCreatedAt + 901e3))).rejects.toMatchObject({
    code: 'stale_session',
  });
  await expect(changeStaffRole(ctx, { userId: target.userId, role: 'agent_bot' })).rejects.toMatchObject({ code: 'invalid_input' });
  await expect(changeStaffRole(ctx, { userId: '00000000-0000-7000-8000-000000000000', role: 'care' })).rejects.toMatchObject({ code: 'not_found' });
  await changeStaffRole(ctx, { userId: target.userId, role: 'agent_l2', isLead: true });
  expect((await pools.root.query(`select role, is_lead from hdu_staff where user_id = $1`, [target.userId])).rows).toEqual([{ role: 'agent_l2', is_lead: true }]);
  const audit = (await pools.root.query(`select diff from hdc_audit_log where action = 'staff.role_changed'`)).rows;
  expect(audit.at(-1)?.diff).toEqual({ from: 'agent_l1', to: 'agent_l2', isLead: true });
  // Признак руководителя без смены роли тоже записывается.
  await changeStaffRole(ctx, { userId: target.userId, role: 'agent_l2', isLead: false });
  expect((await pools.root.query(`select is_lead from hdu_staff where user_id = $1`, [target.userId])).rows).toEqual([{ is_lead: false }]);
  // AI-сотрудник здесь не меняется (вход у него запрещён, поэтому строка без второго фактора).
  const bot = await createStaffFixture({ role: 'agent_bot' });
  await expect(changeStaffRole(ctx, { userId: bot.userId, role: 'care' })).rejects.toMatchObject({ code: 'not_found' });
  await expect(setStaffState(ctx, { userId: bot.userId, state: 'passive' })).rejects.toMatchObject({ code: 'not_found' });
});

test('сброс второго фактора завершает сессии и отправляет сотруднику ссылку', async () => {
  const f = await seedTwoOrgs();
  const target = await enrolled('care');
  await sessionOf(target);
  expect(await resetStaffByMail(staffCtx(f.adminStaff), { userId: target.userId, locale: 'uz' })).toEqual({ mailSent: true });
  expect((await pools.root.query(`select 1 from auth.session where "userId" = $1`, [target.userId])).rowCount).toBe(0);
  expect((await pools.root.query(`select "twoFactorEnabled" from auth."user" where id = $1`, [target.userId])).rows[0].twoFactorEnabled).toBe(false);
  const mail = box.mailer.sent.at(-1);
  expect(mail).toMatchObject({ to: target.email, kind: 'staff-reset' });
  expect(mail?.text).toContain('/uz/staff/setup?token=');
  await expect(resetStaffByMail(staffCtx(f.care), { userId: target.userId, locale: 'ru' })).rejects.toMatchObject({ code: 'forbidden' });
});

test('список сотрудников не раскрывает секреты второго фактора и хеши паролей', async () => {
  const f = await seedTwoOrgs();
  const enrolledCare = await enrolled('care');
  await createStaffFixture({ role: 'agent_bot' });
  const list = await listStaff(staffCtx(f.adminStaff));
  expect(JSON.stringify(list)).not.toMatch(/secret|backupCodes|password|\$2[aby]\$|scrypt/i);
  expect(list.map((s) => s.role)).not.toContain('agent_bot');
  expect(list.find((s) => s.userId === enrolledCare.userId)).toMatchObject({ role: 'care', state: 'active', hasSecondFactor: true, isSelf: false });
  expect(list.find((s) => s.userId === f.adminStaff.userId)).toMatchObject({ isSelf: true, hasSecondFactor: false });
  await expect(listStaff(staffCtx(f.care))).rejects.toMatchObject({ code: 'forbidden' });
  await expect(listStaffInvitations(staffCtx(f.l1))).rejects.toMatchObject({ code: 'forbidden' });
});

test('неверные данные отклоняются без изменений', async () => {
  const f = await seedTwoOrgs();
  const ctx = staffCtx(f.adminStaff);
  for (const bad of [{ email: 'не адрес', name: 'x', role: 'care', locale: 'ru' }, { email: 'a@b.example', name: 'x', role: 'agent_bot', locale: 'ru' }, null])
    await expect(inviteStaffByMail(ctx, bad)).rejects.toMatchObject({ code: 'invalid_input' });
  await expect(setStaffState(ctx, { userId: f.l1.userId, state: 'deleted' })).rejects.toMatchObject({ code: 'invalid_input' });
  await expect(setStaffState(ctx, { userId: 'not-a-uuid', state: 'passive' })).rejects.toMatchObject({ code: 'invalid_input' });
  expect(box.mailer.sent).toEqual([]);
});

// Блокировку проверяет хук создания сессии (auth/hooks.ts): ни пароль, ни код сессии не дают.
test('сотрудник, заблокированный между паролем и кодом, не входит, сессия не остаётся', async () => {
  const target = await enrolled('agent_l2');
  const jar = newJar();
  expect(await signInStaff({ email: target.email, password: target.password }, jar.request)).toEqual({ step: 'code' });
  await pools.root.query(`update hdu_staff set state = 'passive' where user_id = $1`, [target.userId]);
  expect(await verifyStaffCode({ code: totp(target.totpSecret) }, jar.request)).toEqual({ ok: false, code: 'sign_in_expired' });
  expect((await pools.root.query(`select 1 from auth.session where "userId" = $1`, [target.userId])).rowCount).toBe(0);
});

test('приглашение на адрес действующего сотрудника отклоняется: роль меняется только через смену роли (итоговая проверка, I7)', async () => {
  const f = await seedTwoOrgs();
  const target = await enrolled('admin');
  const system = { type: 'system', job: 'test' } as const;
  await expect(inviteStaff(system, { email: target.email, name: 'x', role: 'care' })).rejects.toMatchObject({ code: 'already_member' });
  await expect(inviteStaffByMail(staffCtx(f.adminStaff), { email: target.email, name: 'x', role: 'care', locale: 'ru' })).rejects.toMatchObject({
    code: 'already_member',
  });
  const bot = await createStaffFixture({ role: 'agent_bot' });
  await expect(inviteStaff(system, { email: bot.email, name: 'x', role: 'admin' })).rejects.toMatchObject({ code: 'already_member' });
  expect((await pools.root.query(`select role from hdu_staff where user_id = $1`, [target.userId])).rows).toEqual([{ role: 'admin' }]);
  expect(box.mailer.sent).toEqual([]);
});

test('принятие ссылки после сброса роль сотрудника не меняет', async () => {
  const target = await enrolled('admin');
  const { token } = await resetStaff({ type: 'system', job: 'test' }, { email: target.email });
  // Роль в приглашении подменена в базе: принятие всё равно оставляет роль сотрудника прежней.
  await pools.root.query(`update hdu_invitations set role = 'care' where email = $1 and accepted_on is null and revoked_on is null`, [target.email]);
  await acceptStaffInvitation({ token, name: 'x', password: 'correct-horse-12' });
  expect((await pools.root.query(`select role from hdu_staff where user_id = $1`, [target.userId])).rows).toEqual([{ role: 'admin' }]);
});
