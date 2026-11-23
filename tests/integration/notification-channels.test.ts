import { beforeEach, expect, test } from 'vitest';
import { withActor } from '@/db/with-actor';
import { createTelegramBot } from '@/modules/hdn/api';
import { channelsFor, readPrefs, savePrefs } from '@/modules/hdn/api/notifications';
import { isHdnError } from '@/modules/hdn/error';
import { setTelegramBotForTests } from '@/modules/hdn/testing';
import { pools } from './helpers/db';
import { linkTelegramFixture, memoryBotPerTest } from './helpers/telegram';
import { type Fixture, seedTwoOrgs } from './isolation/fixture';

// Каналы уведомлений клиента (FR-NT-04, FR-NT-14; план M4b, задача 1; решения 3 и 4 вехи M4b).
// Портал всегда; почта и Telegram по выбору; о своих обращениях хотя бы один внешний канал.

memoryBotPerTest();
let f: Fixture;
beforeEach(async () => {
  f = await seedTwoOrgs();
});

const ALL_ON = { own: { email: true, telegram: true }, watched: { email: true, telegram: true } };
const channels = (userId: string, scope: 'own' | 'watched') => withActor(f.l1.actor, (tx) => channelsFor(tx, userId, scope));
const rejectedAs = async (promise: Promise<unknown>, code: string) => {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(isHdnError(error) ? error.code : error).toBe(code);
};

test('по умолчанию почта и Telegram включены для своих и чужих обращений', async () => {
  expect(await readPrefs(f.aUser.actor)).toEqual(ALL_ON);
  // Без привязки Telegram не действует, почта идёт.
  expect(await channels(f.aUser.userId, 'own')).toEqual({ email: true, telegram: false });
  expect(await channels(f.aUser.userId, 'watched')).toEqual({ email: true, telegram: false });
  await linkTelegramFixture(f.aUser, 555001);
  expect(await channels(f.aUser.userId, 'own')).toEqual({ email: true, telegram: true });
  expect(await channels(f.aUser.userId, 'watched')).toEqual({ email: true, telegram: true });
});

test('о своих обращениях почту можно выключить только при привязанном и включённом Telegram', async () => {
  const ownEmailOff = { own: { email: false, telegram: true }, watched: { email: true, telegram: true } };
  await rejectedAs(savePrefs(f.aUser.actor, ownEmailOff), 'invalid_input');
  await linkTelegramFixture(f.aUser, 555002);
  await rejectedAs(savePrefs(f.aUser.actor, { ...ownEmailOff, own: { email: false, telegram: false } }), 'invalid_input');
  await savePrefs(f.aUser.actor, ownEmailOff);
  expect(await readPrefs(f.aUser.actor)).toEqual(ownEmailOff);
  expect(await channels(f.aUser.userId, 'own')).toEqual({ email: false, telegram: true });
  // Бот заблокирован: выключить почту нельзя.
  await pools.root.query(`update hdu_contact_identities set is_blocked = true where user_id = $1`, [f.aUser.userId]);
  await rejectedAs(savePrefs(f.aUser.actor, ownEmailOff), 'invalid_input');
  // В базе запрещено выключить оба канала о своих обращениях.
  await expect(
    pools.root.query(`insert into hdn_notification_prefs (user_id, kind, email_enabled, telegram_enabled) values ($1, 'own_tickets', false, false)`, [f.bUser.userId]),
  ).rejects.toThrow(/hdn_notification_prefs_c2/);
});

test('Telegram без привязки сохранить включённым можно, но канал не действует, пока нет привязки', async () => {
  const prefs = { own: { email: true, telegram: true }, watched: { email: false, telegram: true } };
  await savePrefs(f.aUser.actor, prefs);
  expect(await readPrefs(f.aUser.actor)).toEqual(prefs);
  expect(await channels(f.aUser.userId, 'watched')).toEqual({ email: false, telegram: false });
  await linkTelegramFixture(f.aUser, 555003);
  expect(await channels(f.aUser.userId, 'watched')).toEqual({ email: false, telegram: true });
  await savePrefs(f.aUser.actor, { own: { email: true, telegram: false }, watched: { email: true, telegram: false } });
  expect(await channels(f.aUser.userId, 'own')).toEqual({ email: true, telegram: false });
  expect(await channels(f.aUser.userId, 'watched')).toEqual({ email: true, telegram: false });
});

test('почта выключена, затем Telegram отвязан или бот заблокирован: письма о своих обращениях снова идут', async () => {
  await linkTelegramFixture(f.aUser, 555004);
  await savePrefs(f.aUser.actor, { own: { email: false, telegram: true }, watched: { email: false, telegram: true } });
  await pools.root.query(`update hdu_contact_identities set is_blocked = true where user_id = $1`, [f.aUser.userId]);
  expect(await channels(f.aUser.userId, 'own')).toEqual({ email: true, telegram: false });
  // О чужих обращениях выбор человека остаётся: ни писем, ни Telegram.
  expect(await channels(f.aUser.userId, 'watched')).toEqual({ email: false, telegram: false });
  await pools.root.query(`delete from hdu_contact_identities where user_id = $1`, [f.aUser.userId]);
  expect(await channels(f.aUser.userId, 'own')).toEqual({ email: true, telegram: false });
  // Бот портала выключен на сервере: тоже почта.
  await linkTelegramFixture(f.aUser, 555004);
  expect(await channels(f.aUser.userId, 'own')).toEqual({ email: false, telegram: true });
  setTelegramBotForTests(createTelegramBot({ token: undefined, secret: undefined, apiUrl: 'https://api.telegram.org' }));
  expect(await channels(f.aUser.userId, 'own')).toEqual({ email: true, telegram: false });
});

test('изменение каналов пишется в журнал аудита notify.channels_changed без идентификатора Telegram', async () => {
  await linkTelegramFixture(f.aUser, 555005);
  await savePrefs(f.aUser.actor, { own: { email: false, telegram: true }, watched: { email: true, telegram: false } });
  const rows = (await pools.root.query(`select object_type, object_id, diff from hdc_audit_log where action = 'notify.channels_changed'`)).rows;
  expect(rows).toEqual([{ object_type: 'user', object_id: f.aUser.userId, diff: { own: { email: false, telegram: true }, watched: { email: true, telegram: false } } }]);
  expect(JSON.stringify(rows)).not.toContain('555005');
  // Сохранение без изменений журнал не пополняет.
  await savePrefs(f.aUser.actor, { own: { email: false, telegram: true }, watched: { email: true, telegram: false } });
  expect((await pools.root.query(`select count(*)::int as n from hdc_audit_log where action = 'notify.channels_changed'`)).rows[0].n).toBe(1);
});

test('прежняя настройка watched_tickets из M4 читается как watched.email', async () => {
  await pools.root.query(`delete from hdn_notification_prefs where user_id = $1`, [f.aUser.userId]);
  await pools.root.query(`insert into hdn_notification_prefs (user_id, kind, email_enabled) values ($1, 'watched_tickets', false)`, [f.aUser.userId]);
  expect(await readPrefs(f.aUser.actor)).toEqual({ own: { email: true, telegram: true }, watched: { email: false, telegram: true } });
  expect(await channels(f.aUser.userId, 'watched')).toEqual({ email: false, telegram: false });
});

test('схема: прежний вид настроек, лишние поля и настройки сотрудника клиенту не принимаются', async () => {
  await rejectedAs(savePrefs(f.aUser.actor, { watchedTickets: false }), 'invalid_input');
  await rejectedAs(savePrefs(f.aUser.actor, { ...ALL_ON, extra: true }), 'invalid_input');
  await rejectedAs(savePrefs(f.aUser.actor, { staffMention: false, staffBreach: true }), 'invalid_input');
  await rejectedAs(savePrefs(f.l1.actor, ALL_ON), 'invalid_input');
});
