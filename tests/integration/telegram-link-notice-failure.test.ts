import { expect, test, vi } from 'vitest';
import { handleTelegramUpdate } from '@/modules/hdu/api/telegram';
import { pools } from './helpers/db';
import { memoryMailerPerTest } from './helpers/mail';
import { linkCodeFor, memoryBotPerTest, tgUpdate } from './helpers/telegram';
import { seedTwoOrgs } from './isolation/fixture';

// Сбой уведомления о привязке в портале не отменяет письмо о привязке (угроза T30) и не превращается в ошибку
// вебхука: повтор события дал бы ответ "код недействителен" уже привязанному человеку (итоговая проверка M4b, I2).

vi.mock('@/modules/hdn/api/notifications', async (original) => ({
  ...(await original<typeof import('@/modules/hdn/api/notifications')>()),
  notifyTelegramLinked: vi.fn(async () => {
    throw new Error('сбой базы');
  }),
}));

const tg = memoryBotPerTest();
const mail = memoryMailerPerTest();

test('сбой уведомления о привязке: письмо о привязке уходит, бот подтверждает привязку, ошибки нет', async () => {
  const f = await seedTwoOrgs();
  await pools.root.query(`update auth."user" set email = 'a-user@acme.test', "emailVerified" = true where id = $1`, [f.aUser.userId]);
  await expect(handleTelegramUpdate(tgUpdate({ from: 777101, text: `/start ${await linkCodeFor(f.aUser)}` }))).resolves.toBeUndefined();
  expect(mail.mailer.sent.map((m) => m.kind)).toEqual(['telegram-linked']);
  expect(tg.bot.sent.at(-1)?.text).toContain(f.aUser.name);
  expect((await pools.root.query(`select count(*)::int as n from hdu_contact_identities where user_id = $1`, [f.aUser.userId])).rows[0].n).toBe(1);
});
