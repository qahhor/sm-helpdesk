import 'server-only';
import { getEnv } from '@/env';
import { isLocale, type Locale } from '@/i18n/locales';
import { resolveLocale } from '@/i18n/resolve-locale';
import { RATE_RULES } from '@/modules/hdc/pref';
import { consumeRateLimit, rateKey } from '@/modules/hdc/rate-limit';
import { botText, getTelegramBot, queueMail, type SendOptions, type TelegramUpdate, type TelegramUser, telegramLinkedMail } from '@/modules/hdn/api';
import {
  consumeLinkCode,
  createLinkCode,
  findOwnIdentity,
  findTelegramIdentity,
  setUserLocale,
  unlinkByExternalId,
  unlinkOwn,
} from '../core/telegram';
import { tokenInput } from '../input';
import { hashToken } from '../tokens';
import { type ClientContext, resolveClient } from './orgs';
import { readSession, type RequestInfo } from './request';

// Привязка Telegram и команды бота (FR-ID-14, FR-NT-16, угроза T30, решение 0018).
// Привязывают только клиенты: функции принимают ClientContext, сотрудники Telegram не привязывают.

/** Ссылка на бота с одноразовым кодом привязки: t.me/<бот>?start=<код>. 5 ссылок в час на пользователя. */
export async function startTelegramLink(ctx: ClientContext): Promise<{ url: string } | { error: 'disabled' | 'rate_limited' }> {
  const bot = getTelegramBot();
  if (!bot.enabled) return { error: 'disabled' };
  const limit = await consumeRateLimit(rateKey('telegram-link:user', ctx.user.id), RATE_RULES.telegramLinkPerUser);
  if (!limit.allowed) return { error: 'rate_limited' };
  const code = await createLinkCode(ctx.actor);
  const { username } = await bot.getMe();
  return { url: `https://t.me/${username}?start=${code}` };
}

/** То же по кукам запроса: для обработчика кнопки "Привязать Telegram". Только клиент с организацией. */
export async function startTelegramLinkOfRequest(
  request: Pick<RequestInfo, 'headers'>,
): Promise<{ url: string } | { error: 'disabled' | 'rate_limited' | 'no_session' }> {
  const client = await resolveClient(await readSession(request));
  if ('denied' in client) return { error: 'no_session' };
  return startTelegramLink(client);
}

/** Включён ли бот: без него раздел "Каналы связи" и кнопка в шаге первого входа не показываются. */
export function telegramEnabled(): boolean {
  return getTelegramBot().enabled;
}

/** Своя привязка: как показать аккаунт и с какого времени он привязан. */
export async function getTelegramLink(ctx: ClientContext): Promise<{ displayName: string; linkedOn: Date } | null> {
  const found = await findOwnIdentity(ctx.actor);
  return found ? { displayName: found.displayName ?? 'Telegram', linkedOn: found.verifiedOn } : null;
}

/** Отвязка кнопкой в портале. Бот подтверждает отвязку в диалоге: человек видит, что аккаунт отвязан. */
export async function unlinkTelegram(ctx: ClientContext): Promise<void> {
  const externalId = await unlinkOwn(ctx.actor);
  const bot = getTelegramBot();
  if (!externalId || !bot.enabled) return;
  const locale = ctx.user.locale ?? 'ru';
  await bot.sendMessage(externalId, botText(locale, 'unlinked')).catch(() => {
    // Сообщение в бот не дошло: отвязка уже сделана, портал об этом сказал.
  });
}

/** Язык писем и сообщений бота в учётной записи: выбор в портале или команда бота. */
export async function rememberLocale(userId: string, locale: Locale): Promise<void> {
  await setUserLocale(userId, locale);
}

const displayNameOf = (user: TelegramUser) =>
  (user.username ? `@${user.username}` : [user.first_name, user.last_name].filter(Boolean).join(' ')).slice(0, 100);

const portalButton = (locale: Locale): SendOptions => ({
  linkButton: { text: botText(locale, 'buttonPortal'), url: `${getEnv().HUB_URL}/${locale}` },
});

/**
 * Событие бота. Принимается только личный диалог с человеком: группы и другие боты без ответа.
 * Команды: /start <код> (привязка), /unlink, /lang и кнопки под сообщениями. На всё остальное короткий
 * ответ со ссылкой на портал (FR-NT-16). Ответ на языке учётной записи, для непривязанного собеседника
 * на языке из Telegram, иначе по-русски.
 */
export async function handleTelegramUpdate(update: TelegramUpdate): Promise<void> {
  const message = update.message;
  const callback = update.callback_query;
  const from = message?.from ?? callback?.from;
  const chatType = message?.chat.type ?? callback?.message?.chat.type ?? 'private';
  if (!from || from.is_bot || chatType !== 'private') return;

  const bot = getTelegramBot();
  const externalId = String(from.id);
  const chatId = String(message?.chat.id ?? callback?.message?.chat.id ?? from.id);
  const identity = await findTelegramIdentity(externalId);
  const locale: Locale = identity?.locale ?? resolveLocale({ acceptLanguage: from.language_code ?? null });
  const reply = (text: string, opts?: SendOptions) => bot.sendMessage(chatId, text, opts);
  const fallback = () => reply(botText(locale, 'fallback'), portalButton(locale));

  async function unlink() {
    if (!identity) return reply(botText(locale, 'notLinked'), portalButton(locale));
    await unlinkByExternalId(externalId);
    return reply(botText(locale, 'unlinked'));
  }

  async function chooseLanguage() {
    if (!identity) return reply(botText(locale, 'notLinked'), portalButton(locale));
    const choices = (['ru', 'uz', 'en'] as const).map((code) => ({ text: botText(code, 'languageName'), data: `lang:${code}` }));
    return reply(botText(locale, 'chooseLanguage'), { choices });
  }

  async function setLanguage(code: string) {
    if (!isLocale(code)) return fallback();
    if (!identity) return reply(botText(locale, 'notLinked'), portalButton(locale));
    await setUserLocale(identity.userId, code);
    return reply(botText(code, 'languageSet'));
  }

  async function link(code: string) {
    const parsed = tokenInput.safeParse(code);
    const result = parsed.success ? await consumeLinkCode(hashToken(parsed.data), { externalId, displayName: displayNameOf(from as TelegramUser) }) : 'invalid';
    if (result === 'invalid') return reply(botText(locale, 'codeInvalid'), portalButton(locale));
    if (result === 'taken') return reply(botText(locale, 'alreadyLinked'));
    const replyLocale = result.locale ?? locale;
    await reply(botText(replyLocale, 'linked', { name: result.userName, org: result.orgName ?? '' }), {
      choices: [
        { text: botText(replyLocale, 'buttonSignIn'), data: 'login' },
        { text: botText(replyLocale, 'buttonLanguage'), data: 'lang' },
        { text: botText(replyLocale, 'buttonUnlink'), data: 'unlink' },
      ],
    });
    // Письмо о новой привязке на подтверждённый адрес (угроза T30): привязал не человек, он отвяжет аккаунт.
    if (result.email)
      queueMail({
        to: result.email,
        kind: 'telegram-linked',
        ...telegramLinkedMail(replyLocale, { account: displayNameOf(from as TelegramUser), url: `${getEnv().HUB_URL}/${replyLocale}/settings` }),
      });
  }

  if (callback) {
    // Снять ожидание на кнопке. Если не получилось, ответ ниже всё равно уйдёт.
    await bot.answerCallback(callback.id).catch(() => {});
    const data = callback.data ?? '';
    if (data === 'unlink') return unlink();
    if (data === 'lang') return chooseLanguage();
    if (data.startsWith('lang:')) return setLanguage(data.slice('lang:'.length));
    return fallback();
  }

  const [rawCommand = '', argument] = (message?.text ?? '').trim().split(/\s+/, 2);
  // Команда в группе приходит как /start@имя_бота: имя бота отбрасывается.
  const command = rawCommand.split('@')[0];
  if (command === '/start' && argument) return link(argument);
  if (command === '/unlink') return unlink();
  if (command === '/lang') return chooseLanguage();
  return fallback();
}
