import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import { botText, createTelegramBot, setTelegramBotForTests } from '@/modules/hdn/api';
import { getTelegramLink, handleTelegramUpdate, rememberLocale, startTelegramLink, unlinkTelegram } from '@/modules/hdu/api/telegram';
import { hashToken } from '@/modules/hdu/tokens';
import { clientCtx } from './helpers/auth';
import { pools } from './helpers/db';
import { memoryMailerPerTest } from './helpers/mail';
import { type MockServer, registerMock, ssoSignIn, startMockOidc } from './helpers/sso';
import { linkCodeFor, linkTelegramFixture, memoryBotPerTest, tgUpdate } from './helpers/telegram';
import { seedTwoOrgs } from './isolation/fixture';

// Привязка Telegram (FR-ID-14, решение 94 ТЗ, угроза T30, решение 0018).

const tg = memoryBotPerTest();
const mail = memoryMailerPerTest();
let mock: MockServer;
beforeAll(async () => {
  mock = await startMockOidc('mock', 3290);
});
afterAll(() => mock.stop());
beforeEach(() => registerMock(mock, { isDefault: true }));

const start = (code: string, from = 777001) => tgUpdate({ from, text: `/start ${code}` });

test('кнопка в портале даёт ссылку на бота с одноразовым кодом, в базе только хеш', async () => {
  const f = await seedTwoOrgs();
  const link = await startTelegramLink(await clientCtx(f.aUser));
  expect(link).toHaveProperty('url');
  const url = (link as { url: string }).url;
  expect(url).toMatch(/^https:\/\/t\.me\/[A-Za-z0-9_]+\?start=[\w-]{43}$/);
  const code = new URL(url).searchParams.get('start') ?? '';
  const row = (await pools.root.query(`select code_hash, kind, expires_on - now() as ttl from hdu_link_codes where user_id = $1`, [f.aUser.userId])).rows[0];
  expect(row.code_hash).toBe(hashToken(code));
  expect(row.kind).toBe('telegram');
  expect(row.ttl.minutes).toBe(9);
});

test('новая ссылка отменяет прежнюю', async () => {
  const f = await seedTwoOrgs();
  const first = await linkCodeFor(f.aUser);
  const second = await linkCodeFor(f.aUser);
  await tgHandle(start(first));
  expect((await pools.root.query('select 1 from hdu_contact_identities')).rowCount).toBe(0);
  await tgHandle(start(second));
  expect((await pools.root.query('select 1 from hdu_contact_identities')).rowCount).toBe(1);
});

const tgHandle = handleTelegramUpdate;

test('код привязывает аккаунт, бот называет учётную запись и организацию, действие записано в журнал', async () => {
  const f = await seedTwoOrgs();
  const code = await linkCodeFor(f.aUser);
  await handleTelegramUpdate(start(code));
  expect(
    (await pools.root.query(`select kind, external_id, display_name, verified, is_blocked from hdu_contact_identities where user_id = $1`, [f.aUser.userId])).rows,
  ).toEqual([{ kind: 'telegram', external_id: '777001', display_name: '@user777001', verified: 'linked', is_blocked: false }]);
  const reply = tg.bot.sent.at(-1);
  expect(reply).toMatchObject({ chatId: '777001' });
  expect(reply?.text).toContain(f.orgA.name);
  expect(reply?.text).toContain(f.aUser.name);
  expect(reply?.choices?.map((c) => c.data)).toEqual(['login', 'lang', 'unlink']);
  const audit = (await pools.root.query(`select action, object_id, diff from hdc_audit_log where action = 'telegram.linked'`)).rows;
  expect(audit).toHaveLength(1);
  expect(audit[0].object_id).toBe(f.aUser.userId);
  expect(JSON.stringify(audit)).not.toContain('777001');
  expect(await getTelegramLink(await clientCtx(f.aUser))).toMatchObject({ displayName: '@user777001' });
});

test('код срабатывает один раз и живёт 10 минут', async () => {
  const f = await seedTwoOrgs();
  const code = await linkCodeFor(f.aUser);
  await handleTelegramUpdate(start(code));
  await handleTelegramUpdate(start(code, 777002));
  expect((await pools.root.query(`select external_id from hdu_contact_identities`)).rows).toEqual([{ external_id: '777001' }]);
  expect(tg.bot.sent.at(-1)?.text).toBe(botText('ru', 'codeInvalid'));
  const late = await linkCodeFor(f.bUser);
  await pools.root.query(`update hdu_link_codes set expires_on = now() - interval '1 second' where user_id = $1`, [f.bUser.userId]);
  await handleTelegramUpdate(start(late, 777003));
  expect((await pools.root.query(`select 1 from hdu_contact_identities where user_id = $1`, [f.bUser.userId])).rowCount).toBe(0);
  for (const bad of ['', 'x', 'x'.repeat(500)]) await handleTelegramUpdate(start(bad, 777004));
  expect((await pools.root.query(`select 1 from hdu_contact_identities where external_id = '777004'`)).rowCount).toBe(0);
});

test('аккаунт Telegram, привязанный к одному пользователю, не переходит к другому', async () => {
  const f = await seedTwoOrgs();
  await handleTelegramUpdate(start(await linkCodeFor(f.aUser)));
  await handleTelegramUpdate(start(await linkCodeFor(f.bUser)));
  expect((await pools.root.query(`select user_id from hdu_contact_identities where external_id = '777001'`)).rows).toEqual([{ user_id: f.aUser.userId }]);
  expect(tg.bot.sent.at(-1)?.text).toBe(botText('ru', 'alreadyLinked'));
});

test('новая привязка того же пользователя заменяет прежнюю', async () => {
  const f = await seedTwoOrgs();
  await handleTelegramUpdate(start(await linkCodeFor(f.aUser), 777001));
  await handleTelegramUpdate(start(await linkCodeFor(f.aUser), 777009));
  expect((await pools.root.query(`select external_id from hdu_contact_identities where user_id = $1`, [f.aUser.userId])).rows).toEqual([{ external_id: '777009' }]);
});

test('пользователь с подтверждённым адресом получает письмо о новой привязке', async () => {
  const f = await seedTwoOrgs();
  await pools.root.query(`update auth."user" set email = 'a-user@acme.test', "emailVerified" = true where id = $1`, [f.aUser.userId]);
  await handleTelegramUpdate(start(await linkCodeFor(f.aUser)));
  expect(mail.mailer.sent.map((m) => [m.to, m.kind])).toEqual([['a-user@acme.test', 'telegram-linked']]);
  expect(mail.mailer.sent[0]?.text).toContain('@user777001');
  expect(mail.mailer.sent[0]?.text).toContain('http://localhost:3000/ru/settings');
});

test('отвязка из бота и из портала удаляет идентификатор', async () => {
  const f = await seedTwoOrgs();
  await linkTelegramFixture(f.aUser, 777001);
  await linkTelegramFixture(f.bUser, 777002);
  await handleTelegramUpdate(tgUpdate({ from: 777001, text: '/unlink' }));
  expect(tg.bot.sent.at(-1)?.text).toBe(botText('ru', 'unlinked'));
  await unlinkTelegram(await clientCtx(f.bUser));
  expect((await pools.root.query('select 1 from hdu_contact_identities')).rowCount).toBe(0);
  expect((await pools.root.query(`select count(*)::int as n from hdc_audit_log where action = 'telegram.unlinked'`)).rows[0].n).toBe(2);
  // Кнопка "Отвязать" в сообщении о привязке делает то же.
  await linkTelegramFixture(f.aUser, 777001);
  await handleTelegramUpdate(tgUpdate({ from: 777001, callback: 'unlink' }));
  expect((await pools.root.query('select 1 from hdu_contact_identities')).rowCount).toBe(0);
  expect(tg.bot.answered.length).toBeGreaterThan(0);
});

test('язык из бота записывается в учётную запись, следующий ответ идёт на нём', async () => {
  const f = await seedTwoOrgs();
  await linkTelegramFixture(f.aUser, 777001);
  await handleTelegramUpdate(tgUpdate({ from: 777001, text: '/lang' }));
  expect(tg.bot.sent.at(-1)?.choices?.map((c) => c.data)).toEqual(['lang:ru', 'lang:uz', 'lang:en']);
  await handleTelegramUpdate(tgUpdate({ from: 777001, callback: 'lang:uz' }));
  expect((await pools.root.query(`select locale from auth."user" where id = $1`, [f.aUser.userId])).rows[0].locale).toBe('uz');
  expect(tg.bot.sent.at(-1)?.text).toBe(botText('uz', 'languageSet'));
  await handleTelegramUpdate(tgUpdate({ from: 777001, text: 'salom' }));
  expect(tg.bot.sent.at(-1)?.text).toBe(botText('uz', 'fallback'));
  await handleTelegramUpdate(tgUpdate({ from: 777001, callback: 'lang:xx' }));
  expect((await pools.root.query(`select locale from auth."user" where id = $1`, [f.aUser.userId])).rows[0].locale).toBe('uz');
});

test('на любое другое сообщение бот отвечает ссылкой на портал', async () => {
  await handleTelegramUpdate(tgUpdate({ from: 555, text: 'у меня не грузится отчёт', languageCode: 'en' }));
  expect(tg.bot.sent.at(-1)).toMatchObject({ chatId: '555', text: botText('en', 'fallback'), linkButton: { url: expect.stringMatching(/^http:\/\/localhost:3000\/en/) } });
  await handleTelegramUpdate(tgUpdate({ from: 556, text: '/start' }));
  expect(tg.bot.sent.at(-1)).toMatchObject({ chatId: '556', text: botText('ru', 'fallback') });
  await handleTelegramUpdate(tgUpdate({ from: 557, callback: 'nonsense' }));
  expect(tg.bot.sent.at(-1)).toMatchObject({ chatId: '557', text: botText('ru', 'fallback') });
  // Непривязанный собеседник не меняет ничего: команды учётной записи отвечают, что привязки нет.
  await handleTelegramUpdate(tgUpdate({ from: 558, text: '/unlink' }));
  expect(tg.bot.sent.at(-1)?.text).toBe(botText('ru', 'notLinked'));
});

test('сообщения из групп и от ботов игнорируются', async () => {
  await handleTelegramUpdate(tgUpdate({ from: 555, text: '/start', chatType: 'group' }));
  await handleTelegramUpdate(tgUpdate({ from: 556, text: '/start', isBot: true }));
  await handleTelegramUpdate(tgUpdate({ from: 557, callback: 'lang:ru', chatType: 'supergroup' }));
  expect(tg.bot.sent).toEqual([]);
});

test('шестая ссылка привязки за час не выдаётся', async () => {
  const f = await seedTwoOrgs();
  const ctx = await clientCtx(f.aUser);
  for (let i = 0; i < 5; i++) expect(await startTelegramLink(ctx)).toHaveProperty('url');
  expect(await startTelegramLink(ctx)).toEqual({ error: 'rate_limited' });
});

test('при выключенном боте привязка недоступна', async () => {
  const f = await seedTwoOrgs();
  setTelegramBotForTests(createTelegramBot({ apiUrl: 'https://api.telegram.org' }));
  expect(await startTelegramLink(await clientCtx(f.aUser))).toEqual({ error: 'disabled' });
});

test('язык из Smartup при первом входе и выбор языка в портале попадают в учётную запись', async () => {
  const s = await ssoSignIn(mock, { sub: '7001', name: 'x', company_id: '501', company_name: 'ACME Trade', locale: 'uz' });
  expect((await pools.root.query(`select locale from auth."user" where id = $1`, [s.user.id])).rows[0].locale).toBe('uz');
  expect(s.user.locale).toBe('uz');
  await rememberLocale(s.user.id, 'en');
  await ssoSignIn(mock, { sub: '7001', name: 'x', company_id: '501', company_name: 'ACME Trade', locale: 'uz' });
  // Выбор человека важнее языка из Smartup.
  expect((await pools.root.query(`select locale from auth."user" where id = $1`, [s.user.id])).rows[0].locale).toBe('en');
  const other = await ssoSignIn(mock, { sub: '7002', name: 'y', company_id: '501', company_name: 'ACME Trade', locale: 'de-DE' });
  expect((await pools.root.query(`select locale from auth."user" where id = $1`, [other.user.id])).rows[0].locale).toBeNull();
});

test('сбой ответа бота после привязки не отменяет её, письмо о привязке уходит, повтора не нужно (итоговая проверка, I4)', async () => {
  const f = await seedTwoOrgs();
  await pools.root.query(`update auth."user" set email = 'a-user@acme.test', "emailVerified" = true where id = $1`, [f.aUser.userId]);
  tg.bot.failNext();
  await expect(handleTelegramUpdate(start(await linkCodeFor(f.aUser)))).resolves.toBeUndefined();
  expect((await pools.root.query(`select external_id from hdu_contact_identities where user_id = $1`, [f.aUser.userId])).rows).toEqual([
    { external_id: '777001' },
  ]);
  expect(mail.mailer.sent.map((m) => m.kind)).toEqual(['telegram-linked']);
  // Сбой ответа на команду без изменений тоже не превращается в ошибку вебхука.
  tg.bot.failNext();
  await expect(handleTelegramUpdate(tgUpdate({ from: 777001, text: 'привет' }))).resolves.toBeUndefined();
});

test('Telegram не отвечает: кнопка привязки не падает ошибкой и не тратит попытку (итоговая проверка, I2)', async () => {
  const f = await seedTwoOrgs();
  setTelegramBotForTests(
    createTelegramBot({
      token: '1:x',
      secret: 'secret-secret-secret-secret-secret-0',
      apiUrl: 'http://localhost:3199',
      fetch: async () => Promise.reject(new TypeError('сеть')),
    }),
  );
  const ctx = await clientCtx(f.aUser);
  expect(await startTelegramLink(ctx)).toEqual({ error: 'unavailable' });
  expect((await pools.root.query(`select 1 from hdu_link_codes where user_id = $1`, [f.aUser.userId])).rowCount).toBe(0);
  expect((await pools.root.query(`select 1 from hdc_rate_limits where code like 'telegram-link:%'`)).rowCount).toBe(0);
});
