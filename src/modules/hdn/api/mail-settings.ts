import 'server-only';
import { randomBytes } from 'node:crypto';
import { desc, eq, like } from 'drizzle-orm';
import * as z from 'zod';
import { withActor } from '@/db/with-actor';
import { getEnv } from '@/env';
import { FRESH_SIGN_IN_SEC, isFresh, readSetting, type StaffContext, writeAudit, writeSettingTx } from '@/modules/hdc/api';
import { ONCALL_EMAILS_SETTING, oncallEmails, SUPPORT_ADDRESSES_SETTING, shownSupportAddress, supportAddresses } from '../core/mail-settings';
import { BOT_TOKEN, ONCALL_BOT_SETTING, ONCALL_CHAT, ONCALL_CHAT_SETTING, oncallSender, oncallTokenSaved, saveOncallBotToken } from '../core/oncall';
import { HdnError } from '../error';
import { renderMail } from '../mail/render';
import { getEmailProvider } from '../provider';
import { blockedSenders, emailInbound } from '../schema';
import ru from '../../../../messages/ru.json';

// Модуль hdn, слой api: экран "Уведомления и почта" (FR-EM-13, FR-EM-14, FR-ADM-14; решения 8, 23, 24 вехи M4). Меняет
// только администратор портала (решение 0019), каждое изменение в журнал аудита, токен бота в журнал не попадает.

export { shownSupportAddress, supportAddresses };
export { HDN_ERROR_CODES, type HdnErrorCode, isHdnError } from '../error';

/** Отметка проверочного письма в теме: по ней разбор писем узнаёт его и не создаёт обращение. */
const TEST_MARK = /HUB-TEST-[0-9a-f]{12}/;
const INBOUND_TESTS_SETTING = 'mail.inbound_tests';
const SYSTEM = { type: 'system', job: 'settings.mail' } as const;

const address = z.email().max(320).transform((value) => value.toLowerCase());
const supportInput = z
  .array(z.object({ address, shown: z.boolean() }).strict())
  .min(1)
  .max(20)
  .refine((list) => list.filter((item) => item.shown).length === 1)
  .refine((list) => new Set(list.map((item) => item.address)).size === list.length);
const oncallInput = z
  .object({
    emails: z.array(address).max(20),
    chatId: ONCALL_CHAT.nullable(),
    bot: z.enum(['main', 'own']),
    botToken: BOT_TOKEN.optional(),
  })
  .strict();
const testsValue = z.record(z.string(), z.object({ token: z.string().regex(TEST_MARK), sentOn: z.string() }));

function requireAdmin(ctx: StaffContext): void {
  if (ctx.actor.type !== 'staff' || ctx.actor.staffRole !== 'admin') throw new HdnError('forbidden');
}

/** Изменение настройки: администратор со входом не старше 15 минут (ТЗ 14.3, решение 0014; аудит 23.11.2026, S10). */
function requireFreshAdmin(ctx: StaffContext): void {
  requireAdmin(ctx);
  if (!isFresh(ctx, new Date(), FRESH_SIGN_IN_SEC)) throw new HdnError('stale_session');
}

function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const parsed = schema.safeParse(input);
  if (!parsed.success) throw new HdnError('invalid_input');
  return parsed.data;
}

// --- Адреса поддержки (решение 23) ---

/** Список адресов поддержки: ровно один показывается клиентам (подвал портала и письма). */
export async function saveSupportAddresses(ctx: StaffContext, input: unknown): Promise<void> {
  requireFreshAdmin(ctx);
  const list = parse(supportInput, input);
  await withActor(ctx.actor, (tx) => writeSettingTx(tx, SUPPORT_ADDRESSES_SETTING, list));
}

export type InboundTestStatus = 'never' | 'waiting' | 'received';

async function inboundTests(): Promise<Record<string, { token: string; sentOn: string }>> {
  const parsed = testsValue.safeParse(await readSetting(INBOUND_TESTS_SETTING));
  return parsed.success ? parsed.data : {};
}

/** Проверка приёма адреса: не проверялся, письмо ушло и ждём, письмо дошло до портала через переадресацию. */
export async function inboundTestStatus(value: string): Promise<InboundTestStatus> {
  const test = (await inboundTests())[value.toLowerCase()];
  if (!test) return 'never';
  const rows = await withActor(SYSTEM, (tx) =>
    tx.select({ id: emailInbound.inboundId }).from(emailInbound).where(like(emailInbound.subject, `%${test.token}%`)).limit(1),
  );
  return rows.length > 0 ? 'received' : 'waiting';
}

/** Адреса поддержки с итогом проверки приёма для экрана настроек. */
export async function listSupportAddresses(ctx: StaffContext): Promise<{ address: string; shown: boolean; test: InboundTestStatus }[]> {
  requireAdmin(ctx);
  return Promise.all((await supportAddresses()).map(async (item) => ({ ...item, test: await inboundTestStatus(item.address) })));
}

/**
 * "Проверить приём" (FR-EM-13): проверочное письмо на адрес поддержки. Переадресация приводит его в портал, разбор
 * узнаёт отметку в теме и обращение не создаёт, строка адреса показывает "Письмо получено".
 */
export async function sendInboundTest(ctx: StaffContext, value: unknown): Promise<void> {
  requireAdmin(ctx);
  const target = parse(address, value);
  if (!(await supportAddresses()).some((item) => item.address === target)) throw new HdnError('invalid_input');
  const token = `HUB-TEST-${randomBytes(6).toString('hex')}`;
  const env = getEnv();
  const mail = await renderMail('inbound_test', 'ru', { template: 'inbound_test', address: target, token, hubUrl: env.HUB_URL, supportAddress: null });
  await (await getEmailProvider()).send(
    { to: target, subject: mail.subject, html: mail.html, text: mail.text, headers: { 'Auto-Submitted': 'auto-generated', 'X-Auto-Response-Suppress': 'All' } },
    token,
  );
  const tests = { ...(await inboundTests()), [target]: { token, sentOn: new Date().toISOString() } };
  await withActor(ctx.actor, (tx) => writeSettingTx(tx, INBOUND_TESTS_SETTING, tests, { audit: false }));
}

/** Адрес приёма для переадресации адресов поддержки (FR-EM-13): любой адрес домена приёма, кроме адресов ответа. */
export function intakeAddress(): { domain: string; address: string } | null {
  const domain = getEnv().REPLY_DOMAIN;
  return domain ? { domain, address: `inbox@${domain}` } : null;
}

/** Тема проверочного письма: разбор писем сохраняет его без обращения. */
export function isInboundTestSubject(subject: string): boolean {
  return TEST_MARK.test(subject);
}

// --- Дежурные (решение 8) ---

export type OncallView = { emails: string[]; chatId: string | null; bot: 'main' | 'own'; botTokenSaved: boolean };

export async function readOncall(ctx: StaffContext): Promise<OncallView> {
  requireAdmin(ctx);
  const chat = await readSetting(ONCALL_CHAT_SETTING);
  // Слой базы разбирает строку JSON ещё раз: номер чата из одних цифр приходит числом.
  const chatId = typeof chat === 'number' ? String(chat) : typeof chat === 'string' ? chat : null;
  return { emails: await oncallEmails(), chatId, bot: (await readSetting(ONCALL_BOT_SETTING)) === 'own' ? 'own' : 'main', botTokenSaved: await oncallTokenSaved() };
}

/**
 * Адреса и чат дежурных, бот: основной бот портала или отдельный. Токен отдельного бота хранится зашифрованным,
 * в журнале только отметка, что его заменили. Отдельный бот без токена (ни нового, ни сохранённого) не принимается.
 */
export async function saveOncall(ctx: StaffContext, input: unknown): Promise<void> {
  requireFreshAdmin(ctx);
  const data = parse(oncallInput, input);
  if (data.bot === 'own' && !data.botToken && !(await oncallTokenSaved())) throw new HdnError('invalid_input');
  if (data.botToken) await saveOncallBotToken(ctx.actor, data.botToken);
  await withActor(ctx.actor, async (tx) => {
    await writeSettingTx(tx, ONCALL_EMAILS_SETTING, data.emails, { audit: false });
    await writeSettingTx(tx, ONCALL_CHAT_SETTING, data.chatId, { audit: false });
    await writeSettingTx(tx, ONCALL_BOT_SETTING, data.bot, { audit: false });
    await writeAudit(tx, {
      action: 'settings.oncall_changed',
      objectType: 'setting',
      objectId: 'notify.oncall',
      diff: { emails: data.emails, chatId: data.chatId, bot: data.bot, botReplaced: Boolean(data.botToken) },
    });
  });
}

/** "Отправить проверочное сообщение" в чат дежурных выбранным ботом. Чат не задан или Telegram отказал: ok ложь. */
export async function sendOncallTest(ctx: StaffContext): Promise<{ ok: boolean }> {
  requireAdmin(ctx);
  const sender = await oncallSender();
  if (!sender) return { ok: false };
  try {
    await sender.send(ru.bot.oncallTest);
    return { ok: true };
  } catch (error) {
    console.error(`Проверочное сообщение дежурным не отправлено: ${error instanceof Error ? error.message : 'ошибка'}`);
    return { ok: false };
  }
}

// --- Отклонённые как спам (решение 14) ---

export async function listBlockedSenders(ctx: StaffContext): Promise<{ address: string; createdOn: Date }[]> {
  requireAdmin(ctx);
  return withActor(ctx.actor, (tx) =>
    tx.select({ address: blockedSenders.address, createdOn: blockedSenders.createdOn }).from(blockedSenders).orderBy(desc(blockedSenders.createdOn)).limit(500),
  );
}

/** Убрать адрес из спама: следующие письма с него снова разбираются как обычно. */
export async function unblockSender(ctx: StaffContext, value: unknown): Promise<void> {
  requireFreshAdmin(ctx);
  const target = parse(address, value);
  await withActor(ctx.actor, async (tx) => {
    const removed = await tx.delete(blockedSenders).where(eq(blockedSenders.address, target)).returning({ address: blockedSenders.address });
    if (removed.length > 0) await writeAudit(tx, { action: 'sender.unblocked', objectType: 'sender', objectId: target });
  });
}
