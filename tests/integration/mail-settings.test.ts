import { beforeEach, expect, test } from 'vitest';
import { readSetting } from '@/modules/hdc/api';
import {
  inboundTestStatus,
  listBlockedSenders,
  readOncall,
  saveOncall,
  saveSupportAddresses,
  sendInboundTest,
  sendOncallTest,
  shownSupportAddress,
  unblockSender,
} from '@/modules/hdn/api/mail-settings';
import { setOncallBotFactoryForTests } from '@/modules/hdn/api/oncall';
import { dispatchOutbox } from '@/modules/hdn/api/outbox';
import { createTicket, readTimings, saveTimings } from '@/modules/hdt/api';
import { addOrgDomain, listOrgDomains, removeOrgDomain } from '@/modules/hdu/api';
import { clientCtx, staffCtx } from './helpers/auth';
import { pools } from './helpers/db';
import { deliver as deliverTo, inboundPerTest, type Letter } from './helpers/inbound';
import { type Fixture, seedTwoOrgs } from './isolation/fixture';

// Настройки уведомлений и почты для администратора (FR-EM-06, FR-EM-13, FR-EM-14, FR-ADM-14; решения 8, 23, 24 вехи M4).

const OUTBOX = { type: 'system', job: 'outbox.dispatch' } as const;
const TOKEN = '123456789:AAE-own-oncall-bot-token-0123456789';
const PAIR = [
  { address: 'support@greenwhite.uz', shown: false },
  { address: 'support@smartup24.com', shown: true },
];

const box = inboundPerTest();
let f: Fixture;

beforeEach(async () => {
  f = await seedTwoOrgs();
});

const deliver = (letter: Letter) => deliverTo(box, letter);
const admin = () => staffCtx(f.adminStaff);
const audit = (action: string) => pools.root.query(`select diff from hdc_audit_log where action = $1 order by created_on`, [action]).then((r) => r.rows.map((row) => row.diff));
/** Домены организации без строки набора данных изоляции. */
const domainsOf = async (orgId: string) => (await listOrgDomains(staffCtx(f.care), orgId)).filter((d) => !d.startsWith('fixture-'));

test('адреса поддержки сохраняет только admin, с записью аудита; без показываемого адреса или с двумя отклоняется', async () => {
  await expect(saveSupportAddresses(staffCtx(f.care), PAIR)).rejects.toMatchObject({ code: 'forbidden' });
  await expect(saveSupportAddresses(admin(), PAIR.map((a) => ({ ...a, shown: false })))).rejects.toMatchObject({ code: 'invalid_input' });
  await expect(saveSupportAddresses(admin(), PAIR.map((a) => ({ ...a, shown: true })))).rejects.toMatchObject({ code: 'invalid_input' });
  await expect(saveSupportAddresses(admin(), [PAIR[1], PAIR[1]] as typeof PAIR)).rejects.toMatchObject({ code: 'invalid_input' });
  await saveSupportAddresses(admin(), [{ address: 'Support@GreenWhite.uz', shown: false }, PAIR[1] as (typeof PAIR)[number]]);
  expect(await readSetting('mail.support_addresses')).toEqual(PAIR);
  expect(await audit('settings.changed')).toEqual([{ code: 'mail.support_addresses', to: PAIR }]);
});

test('показываемый адрес в подвале портала и в письме', async () => {
  await saveSupportAddresses(admin(), PAIR);
  expect(await shownSupportAddress()).toBe('support@smartup24.com');
  await pools.root.query(`update auth."user" set email = 'a-user@example.uz', "emailVerified" = true where id = $1`, [f.aUser.userId]);
  await createTicket(await clientCtx(f.aUser), { description: 'Не печатается накладная', type: 'bug', impact: 'minor', locale: 'ru' });
  await dispatchOutbox(OUTBOX, new Date());
  const sent = box.provider.sent.find((s) => s.message.to === 'a-user@example.uz');
  expect(sent?.message.text).toContain('support@smartup24.com');
  expect(sent?.message.text).not.toContain('support@greenwhite.uz');
});

test('проверка приёма для каждого адреса: "ждём", после прихода "получено"', async () => {
  await saveSupportAddresses(admin(), PAIR);
  expect(await inboundTestStatus('support@greenwhite.uz')).toBe('never');
  await sendInboundTest(admin(), 'support@greenwhite.uz');
  await expect(sendInboundTest(admin(), 'other@greenwhite.uz')).rejects.toMatchObject({ code: 'invalid_input' });
  const sent = box.provider.sent.find((s) => s.message.to === 'support@greenwhite.uz');
  expect(sent?.message.subject).toMatch(/HUB-TEST-[0-9a-f]{12}/);
  expect(await inboundTestStatus('support@greenwhite.uz')).toBe('waiting');
  expect(await inboundTestStatus('support@smartup24.com')).toBe('never');
  // Письмо вернулось через переадресацию: обращения нет, строка "получено".
  const before = (await pools.root.query(`select count(*)::int as n from hdt_tickets`)).rows[0].n;
  const { result } = await deliver({ from: 'Smartup Hub <hub@mail.smartup24.com>', to: ['support@greenwhite.uz'], subject: sent?.message.subject ?? '', text: sent?.message.text ?? '' });
  expect(result).toBe('ignored');
  expect((await pools.root.query(`select count(*)::int as n from hdt_tickets`)).rows[0].n).toBe(before);
  expect(await inboundTestStatus('support@greenwhite.uz')).toBe('received');
});

test('письмо на любой адрес списка создаёт обращение', async () => {
  await saveSupportAddresses(admin(), PAIR);
  expect((await deliver({ from: 'one@unknown.uz', to: ['support@greenwhite.uz'], subject: 'Первый адрес' })).result).toBe('new');
  expect((await deliver({ from: 'two@unknown.uz', to: ['support@smartup24.com'], subject: 'Второй адрес' })).result).toBe('new');
  // Испорченный адрес ответа рядом с адресом поддержки: письмо не теряется.
  expect((await deliver({ from: 'three@unknown.uz', to: ['reply+1.aaaaaaaaaaaaaaaaaaaaaaaaaa.0123456789abcdef0123@reply.example.test'], cc: ['support@smartup24.com'], subject: 'Копия' })).result).toBe('new');
});

test('отдельный бот: токен сохранён зашифрованным, в журнале аудита нет токена, на экране не показывается', async () => {
  // Строка набора данных изоляции: токена отдельного бота ещё нет.
  await pools.root.query(`delete from hdn_channel_secrets`);
  await expect(saveOncall(staffCtx(f.care), { emails: [], chatId: null, bot: 'main' })).rejects.toMatchObject({ code: 'forbidden' });
  await expect(saveOncall(admin(), { emails: ['not-an-email'], chatId: null, bot: 'main' })).rejects.toMatchObject({ code: 'invalid_input' });
  await expect(saveOncall(admin(), { emails: [], chatId: '-100123', bot: 'own' })).rejects.toMatchObject({ code: 'invalid_input' });
  await saveOncall(admin(), { emails: ['duty@greenwhite.uz'], chatId: '-100123', bot: 'own', botToken: TOKEN });
  const secret = (await pools.root.query(`select sealed from hdn_channel_secrets`)).rows.map((r) => r.sealed as string);
  expect(secret).toHaveLength(1);
  expect(secret[0]).not.toContain(TOKEN.split(':')[1]);
  const logged = JSON.stringify((await pools.root.query(`select diff from hdc_audit_log`)).rows);
  expect(logged).not.toContain(TOKEN.split(':')[1]);
  expect(await audit('settings.oncall_changed')).toEqual([{ emails: ['duty@greenwhite.uz'], chatId: '-100123', bot: 'own', botReplaced: true }]);
  expect(await readOncall(admin())).toEqual({ emails: ['duty@greenwhite.uz'], chatId: '-100123', bot: 'own', botTokenSaved: true });
  // Без нового токена сохранённый остаётся.
  await saveOncall(admin(), { emails: ['duty@greenwhite.uz'], chatId: '-100124', bot: 'own' });
  expect((await readOncall(admin())).botTokenSaved).toBe(true);
});

test('проверочное сообщение дежурным уходит выбранным ботом в заданный чат', async () => {
  const sent: { token: string; chatId: string; text: string }[] = [];
  setOncallBotFactoryForTests((token) => ({ send: async (chatId, text) => void sent.push({ token, chatId, text }) }));
  try {
    expect(await sendOncallTest(admin())).toEqual({ ok: false });
    await saveOncall(admin(), { emails: [], chatId: '-100123', bot: 'own', botToken: TOKEN });
    expect(await sendOncallTest(admin())).toEqual({ ok: true });
    expect(sent).toEqual([{ token: TOKEN, chatId: '-100123', text: expect.stringContaining('Smartup Hub') }]);
  } finally {
    setOncallBotFactoryForTests(null);
  }
});

test('сроки вне 1..30 отклоняются; сохранённый срок читают напоминание и автозакрытие', async () => {
  const good = { waitingReminderDays: 2, autocloseResolvedDays: 4, autocloseWaitingDays: 10, updateIntervalDays: 6 };
  expect(await readTimings(admin())).toEqual({ waitingReminderDays: 3, autocloseResolvedDays: 5, autocloseWaitingDays: 7, updateIntervalDays: 5 });
  await expect(saveTimings(admin(), { ...good, autocloseWaitingDays: 31 })).rejects.toMatchObject({ code: 'invalid_input' });
  await expect(saveTimings(admin(), { ...good, waitingReminderDays: 0 })).rejects.toMatchObject({ code: 'invalid_input' });
  await expect(saveTimings(staffCtx(f.care), good)).rejects.toMatchObject({ code: 'forbidden' });
  await saveTimings(admin(), good);
  expect(await readTimings(admin())).toEqual(good);
  expect(await readSetting('tickets.autoclose_waiting_days')).toBe(10);
  expect((await audit('settings.changed')).map((r) => r.code).sort()).toEqual(
    ['notify.waiting_reminder_days', 'sla.update_interval_days', 'tickets.autoclose_resolved_days', 'tickets.autoclose_waiting_days'].sort(),
  );
});

test('домен gmail.com организации не добавляется', async () => {
  for (const domain of ['gmail.com', 'mail.ru', 'Yandex.ru', 'outlook.com'])
    await expect(addOrgDomain(staffCtx(f.care), { orgId: f.orgA.orgId, domain })).rejects.toMatchObject({ code: 'invalid_input' });
  await expect(addOrgDomain(staffCtx(f.care), { orgId: f.orgA.orgId, domain: 'not a domain' })).rejects.toMatchObject({ code: 'invalid_input' });
  expect(await domainsOf(f.orgA.orgId)).toEqual([]);
});

test('домен добавляет care и admin, agent_l1 нет', async () => {
  await addOrgDomain(staffCtx(f.care), { orgId: f.orgA.orgId, domain: 'Company-A.uz' });
  await addOrgDomain(admin(), { orgId: f.orgA.orgId, domain: 'company-a.com' });
  await expect(addOrgDomain(staffCtx(f.l1), { orgId: f.orgA.orgId, domain: 'company-a.org' })).rejects.toMatchObject({ code: 'forbidden' });
  // Домен одной организации другой не достаётся.
  await expect(addOrgDomain(admin(), { orgId: f.orgB.orgId, domain: 'company-a.uz' })).rejects.toMatchObject({ code: 'domain_taken' });
  expect((await listOrgDomains(staffCtx(f.l1), f.orgA.orgId)).filter((d) => !d.startsWith('fixture-'))).toEqual(['company-a.com', 'company-a.uz']);
  expect((await audit('org.domain_added')).map((r) => r.domain).sort()).toEqual(['company-a.com', 'company-a.uz']);
  await removeOrgDomain(staffCtx(f.care), { orgId: f.orgA.orgId, domain: 'company-a.com' });
  expect(await domainsOf(f.orgA.orgId)).toEqual(['company-a.uz']);
  expect(await audit('org.domain_removed')).toEqual([{ domain: 'company-a.com' }]);
});

test('удаление из списка отклонённых возвращает приём писем с адреса', async () => {
  await pools.root.query(`insert into hdn_blocked_senders (address, blocked_by) values ('spammer@unknown.uz', $1)`, [f.l1.userId]);
  expect((await deliver({ from: 'spammer@unknown.uz', subject: 'Снова' })).result).toBe('spam');
  expect((await listBlockedSenders(admin())).map((r) => r.address)).toContain('spammer@unknown.uz');
  await expect(unblockSender(staffCtx(f.care), 'spammer@unknown.uz')).rejects.toMatchObject({ code: 'forbidden' });
  await unblockSender(admin(), 'Spammer@Unknown.uz');
  expect((await listBlockedSenders(admin())).map((r) => r.address)).not.toContain('spammer@unknown.uz');
  expect((await deliver({ from: 'spammer@unknown.uz', subject: 'Теперь вопрос' })).result).toBe('new');
});
