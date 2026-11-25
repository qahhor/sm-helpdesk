import { expect, test } from 'vitest';
import { saveVoteMode, voteMode } from '@/modules/hdi/api/settings';
import { staffCtx } from './helpers/auth';
import { pools } from './helpers/db';
import { seedTwoOrgs } from './isolation/fixture';

// Настройка ideas.vote_mode (план M7, задача 1, решение 3): значение по умолчанию, проверка Zod, меняет только
// администратор со свежим входом, запись в журнал аудита.

test('способ подсчёта: по умолчанию per_user, неверное значение в базе тоже per_user', async () => {
  expect(await voteMode()).toBe('per_user');
  await pools.root.query(`insert into hdc_settings (code, value) values ('ideas.vote_mode', '"per_company"') on conflict (code) do update set value = excluded.value`);
  expect(await voteMode()).toBe('per_user');
  await pools.root.query(`delete from hdc_settings where code = 'ideas.vote_mode'`);
});

test('способ подсчёта меняет только администратор со свежим входом, с записью в журнал', async () => {
  const f = await seedTwoOrgs();
  const admin = staffCtx(f.adminStaff);
  await expect(saveVoteMode(staffCtx(f.care), { mode: 'per_org' })).rejects.toMatchObject({ code: 'forbidden' });
  await expect(saveVoteMode({ ...admin, sessionCreatedAt: new Date(Date.now() - 16 * 60_000) }, { mode: 'per_org' })).rejects.toMatchObject({ code: 'stale_session' });
  await expect(saveVoteMode(admin, { mode: 'per_company' })).rejects.toMatchObject({ code: 'invalid_input' });
  await saveVoteMode(admin, { mode: 'per_org' });
  expect(await voteMode()).toBe('per_org');
  const audit = await pools.root.query(`select diff from hdc_audit_log where action = 'settings.changed' and object_id = 'ideas.vote_mode'`);
  expect(audit.rows.map((r) => r.diff)).toEqual([{ code: 'ideas.vote_mode', to: 'per_org' }]);
  await pools.root.query(`delete from hdc_settings where code = 'ideas.vote_mode'`);
});
