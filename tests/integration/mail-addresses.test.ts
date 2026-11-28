import { expect, test } from 'vitest';
import { mailAddresses, mailRecipient } from '@/modules/hdu/api/recipients';
import { pools } from './helpers/db';
import { countTx } from './helpers/tx';
import { seedTwoOrgs } from './isolation/fixture';

// Адреса для писем нескольких пользователей одной транзакцией (проверка качества, Q21): разбор входящего письма
// сверял адрес отправителя с участниками обращения по одному запросу на участника (до 50 транзакций на письмо).

test('mailAddresses: то же правило, что у mailRecipient, одной транзакцией на всех', async () => {
  const f = await seedTwoOrgs();
  // Подтверждённый адрес, гость с заявленным адресом, неподтверждённый не гость.
  await pools.root.query(`update auth."user" set email = 'verified@acme.test', "emailVerified" = true where id = $1`, [f.aUser.userId]);
  await pools.root.query(`update auth."user" set "emailVerified" = false, "claimedEmail" = 'Guest@Mail.Test' where id = $1`, [f.aAdmin.userId]);
  await pools.root.query(`update hdu_memberships set source = 'guest' where user_id = $1`, [f.aAdmin.userId]);
  await pools.root.query(`update auth."user" set "emailVerified" = false, "claimedEmail" = 'claimed@globex.test' where id = $1`, [f.bUser.userId]);
  const ids = [f.aUser.userId, f.aAdmin.userId, f.bUser.userId, '01900000-0000-7000-8000-000000000000', 'не-uuid'];
  const { result, auth, app } = await countTx(() => mailAddresses(ids));
  expect(auth).toBe(1);
  expect(app).toBe(0);
  const single = new Map<string, string>();
  for (const id of ids) {
    const one = await mailRecipient(id);
    if (one) single.set(id, one.address);
  }
  expect([...result.entries()].sort()).toEqual([...single.entries()].sort());
  expect(result.get(f.aUser.userId)).toBe('verified@acme.test');
  expect(result.get(f.aAdmin.userId)).toBe('Guest@Mail.Test');
  expect(result.has(f.bUser.userId)).toBe(false);
});
