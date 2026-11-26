import { expect, test } from 'vitest';
import { getAuth } from '@/modules/hdu/auth/instance';
import { readSession } from '@/modules/hdu/api/request';
import { resolveStaff, type StaffContext } from '@/modules/hdu/api/session';
import { changeStaffPassword, signInStaff, verifyStaffCode } from '@/modules/hdu/api/staff';
import { freshTotp } from '../helpers/totp';
import { enrolledStaffFixture, newJar, type StaffFixture } from './helpers/auth';
import { pools } from './helpers/db';

// Сотрудник сам меняет пароль (ASVS 5.0.0, требования 6.2.2, 6.2.3 и 7.4.3; план подготовки M9, задача 1). Нужны
// текущий и новый пароль; новый проверяется теми же правилами, что при приглашении. После смены завершаются все
// сессии сотрудника, включая текущую: он входит заново новым паролем и кодом. Смена пишется в журнал аудита.

const NEW_PASSWORD = 'vernyi-kon-batareya-skrepka-72';

async function signedIn(staff: StaffFixture) {
  const jar = newJar();
  expect(await signInStaff({ email: staff.email, password: staff.password }, jar.request)).toEqual({ step: 'code' });
  expect(await verifyStaffCode({ code: freshTotp(staff.totpSecret) }, jar.request)).toEqual({ ok: true });
  const ctx = (await resolveStaff(await readSession(jar.request), new Date())) as StaffContext;
  expect(ctx.actor.type).toBe('staff');
  return { jar, ctx };
}

const sessionsOf = async (userId: string) => (await pools.root.query(`select count(*)::int as n from auth."session" where "userId" = $1`, [userId])).rows[0].n as number;

test('смена пароля: новый пароль действует, прежний нет, все сессии завершены, запись аудита без паролей', async () => {
  const staff = await enrolledStaffFixture(await getAuth(), { role: 'agent_l1' });
  const { jar, ctx } = await signedIn(staff);
  await signedIn(staff);
  expect(await sessionsOf(staff.userId)).toBeGreaterThanOrEqual(2);

  await changeStaffPassword(ctx, { currentPassword: staff.password, newPassword: NEW_PASSWORD }, jar.request);

  expect(await sessionsOf(staff.userId)).toBe(0);
  expect(await readSession(jar.request)).toBeNull();
  expect(await signInStaff({ email: staff.email, password: staff.password }, newJar().request)).toMatchObject({ step: 'error', code: 'invalid_credentials' });
  expect(await signInStaff({ email: staff.email, password: NEW_PASSWORD }, newJar().request)).toEqual({ step: 'code' });
  const audit = (await pools.root.query(`select actor_type, actor_id, object_id, diff from hdc_audit_log where action = 'staff.password_changed'`)).rows;
  expect(audit).toEqual([{ actor_type: 'staff', actor_id: staff.userId, object_id: staff.userId, diff: { sessionsEnded: expect.any(Number) } }]);
  expect(audit[0].diff.sessionsEnded).toBeGreaterThanOrEqual(2);
  expect(JSON.stringify(audit)).not.toContain(NEW_PASSWORD);
});

test('неверный текущий пароль, частый или короткий новый: ничего не меняется', async () => {
  const staff = await enrolledStaffFixture(await getAuth(), { role: 'care' });
  const { jar, ctx } = await signedIn(staff);
  const before = (await pools.root.query(`select password from auth.account where "userId" = $1`, [staff.userId])).rows[0].password;
  await expect(changeStaffPassword(ctx, { currentPassword: 'not-my-password-123', newPassword: NEW_PASSWORD }, jar.request)).rejects.toMatchObject({ code: 'invalid_credentials' });
  await expect(changeStaffPassword(ctx, { currentPassword: staff.password, newPassword: 'Password12345' }, jar.request)).rejects.toMatchObject({ code: 'weak_password' });
  await expect(changeStaffPassword(ctx, { currentPassword: staff.password, newPassword: 'leavemealone' }, jar.request)).rejects.toMatchObject({ code: 'weak_password' });
  await expect(changeStaffPassword(ctx, { currentPassword: staff.password, newPassword: 'short-1' }, jar.request)).rejects.toMatchObject({ code: 'invalid_input' });
  await expect(changeStaffPassword(ctx, { currentPassword: staff.password, newPassword: staff.password }, jar.request)).rejects.toMatchObject({ code: 'invalid_input' });
  expect((await pools.root.query(`select password from auth.account where "userId" = $1`, [staff.userId])).rows[0].password).toBe(before);
  expect(await readSession(jar.request)).not.toBeNull();
  expect((await pools.root.query(`select 1 from hdc_audit_log where action = 'staff.password_changed'`)).rowCount).toBe(0);
});

test('подбор текущего пароля через форму смены ограничен: 5 попыток за 15 минут', async () => {
  const staff = await enrolledStaffFixture(await getAuth(), { role: 'care' });
  const { jar, ctx } = await signedIn(staff);
  for (let attempt = 1; attempt <= 5; attempt++)
    await expect(changeStaffPassword(ctx, { currentPassword: `wrong-password-${attempt}`, newPassword: NEW_PASSWORD }, jar.request)).rejects.toMatchObject({ code: 'invalid_credentials' });
  // Шестая попытка не проверяется даже с верным паролем.
  await expect(changeStaffPassword(ctx, { currentPassword: staff.password, newPassword: NEW_PASSWORD }, jar.request)).rejects.toMatchObject({ code: 'rate_limited' });
  expect(await signInStaff({ email: staff.email, password: staff.password }, newJar().request)).toEqual({ step: 'code' });
});

test('пароль длиной 128 знаков принимается, 129 нет', async () => {
  const staff = await enrolledStaffFixture(await getAuth(), { role: 'care' });
  const { jar, ctx } = await signedIn(staff);
  const long = `${'Длинная фраза без правил состава '.repeat(4)}`.slice(0, 128);
  expect(long.length).toBe(128);
  await expect(changeStaffPassword(ctx, { currentPassword: staff.password, newPassword: `${long}x` }, jar.request)).rejects.toMatchObject({ code: 'invalid_input' });
  await changeStaffPassword(ctx, { currentPassword: staff.password, newPassword: long }, jar.request);
  expect(await signInStaff({ email: staff.email, password: long }, newJar().request)).toEqual({ step: 'code' });
});
