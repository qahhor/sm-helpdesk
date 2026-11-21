import { expect, test } from 'vitest';
import { dismissHints, hintsPending } from '@/modules/hdu/api';
import { clientCtx } from './helpers/auth';
import { pools } from './helpers/db';
import { seedTwoOrgs } from './isolation/fixture';

// Подсказки первого входа (UX-C-14): после шага первого входа, пока человек не нажал "Понятно".

test('подсказки видны после первого входа и скрываются навсегда кнопкой "Понятно"', async () => {
  const f = await seedTwoOrgs();
  await pools.root.query(`update auth."user" set "onboardedAt" = now() where id = $1`, [f.aUser.userId]);
  const ctx = await clientCtx(f.aUser);
  expect(await hintsPending(ctx)).toBe(true);
  await dismissHints(ctx);
  expect(await hintsPending(ctx)).toBe(false);
  // Повторное нажатие время не меняет.
  const first = (await pools.root.query(`select "hintsSeenAt" as at from auth."user" where id = $1`, [f.aUser.userId])).rows[0].at;
  await dismissHints(ctx);
  expect((await pools.root.query(`select "hintsSeenAt" as at from auth."user" where id = $1`, [f.aUser.userId])).rows[0].at).toEqual(first);
  // Коллеге подсказки по-прежнему видны.
  await pools.root.query(`update auth."user" set "onboardedAt" = now() where id = $1`, [f.aAdmin.userId]);
  expect(await hintsPending(await clientCtx(f.aAdmin))).toBe(true);
});

test('до шага первого входа подсказок нет', async () => {
  const f = await seedTwoOrgs();
  await pools.root.query(`update auth."user" set "onboardedAt" = null where id = $1`, [f.bUser.userId]);
  expect(await hintsPending(await clientCtx(f.bUser))).toBe(false);
});
