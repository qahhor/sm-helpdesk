import 'server-only';
import { getEnv } from '@/env';
import { isLocale, type Locale } from '@/i18n/locales';
import { resolveLocale } from '@/i18n/resolve-locale';
import { RATE_RULES } from '@/modules/hdc/pref';
import { clientIp, consumeRateLimit, rateKey } from '@/modules/hdc/api';
import {
  botText,
  getTelegramBot,
  queueMail,
  type SendOptions,
  TelegramError,
  type TelegramUpdate,
  type TelegramUser,
  telegramLinkedMail,
} from '@/modules/hdn/api';
import { createTrustedSession } from '../core/trusted';
import {
  consumeLinkCode,
  consumeLoginCode,
  createLinkCode,
  createLoginCode,
  findOwnIdentity,
  findTelegramIdentity,
  setUserLocale,
  unlinkByExternalId,
  unlinkOwn,
} from '../core/telegram';
import { tokenInput } from '../input';
import { LOGIN_BOT_LINK_TTL_SEC } from '../pref';
import { hashToken } from '../tokens';
import { type ClientContext, resolveClient } from './orgs';
import { readSession, type RequestInfo } from './request';

// Привязка Telegram и команды бота (FR-ID-14, FR-NT-16, угроза T30, решение 0018).
// Привязывают только клиенты: функции принимают ClientContext, сотрудники Telegram не привязывают.

/** Ссылка на бота с одноразовым кодом привязки: t.me/<бот>?start=<код>. 5 ссылок в час на пользователя. */
export async function startTelegramLink(
  ctx: ClientContext,
): Promise<{ url: string } | { error: 'disabled' | 'rate_limited' | 'unavailable' }> {
  const bot = getTelegramBot();
  if (!bot.enabled) return { error: 'disabled' };
  // Имя бота первым: Telegram не отвечает, и попытка не тратится, код не создаётся (итоговая проверка M1).
  let username: string;
  try {
    ({ username } = await bot.getMe());
  } catch (error) {
    if (error instanceof TelegramError) return { error: 'unavailable' };
    throw error;
  }
  const limit = await consumeRateLimit(rateKey('telegram-link:user', ctx.user.id), RATE_RULES.telegramLinkPerUser);
  if (!limit.allowed) return { error: 'rate_limited' };
  const code = await createLinkCode(ctx.actor);
  return { url: `https://t.me/${username}?start=${code}` };
}

/** То же по кукам запроса: для обработчика кнопки "Привязать Telegram". Только клиент с организацией. */
export async function startTelegramLinkOfRequest(
  request: Pick<RequestInfo, 'headers'>,
): Promise<{ url: string } | { error: 'disabled' | 'rate_limited' | 'unavailable' | 'no_session' }> {
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
  // Сбой ответа не превращается в ошибку вебхука: изменения уже сохранены, а повтор события от Telegram
  // дал бы неверный ответ ("код недействителен" после привязки) и вторую ссылку входа. Человек повторит команду.
  const reply = async (text: string, opts?: SendOptions) => {
    try {
      await bot.sendMessage(chatId, text, opts);
    } catch (error) {
      console.error(`Ответ бота не отправлен: ${error instanceof Error ? error.message : 'ошибка'}`);
    }
  };
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
    // Письмо о новой привязке на подтверждённый адрес (угроза T30): привязал не человек, он отвяжет аккаунт.
    // Письмо ставится до ответа бота: сбой ответа его не отменит.
    if (result.email)
      queueMail({
        to: result.email,
        kind: 'telegram-linked',
        ...telegramLinkedMail(replyLocale, { account: displayNameOf(from as TelegramUser), url: `${getEnv().HUB_URL}/${replyLocale}/settings` }),
      });
    await reply(botText(replyLocale, 'linked', { name: result.userName, org: result.orgName ?? '' }), {
      choices: [
        { text: botText(replyLocale, 'buttonSignIn'), data: 'login' },
        { text: botText(replyLocale, 'buttonLanguage'), data: 'lang' },
        { text: botText(replyLocale, 'buttonUnlink'), data: 'unlink' },
      ],
    });
  }

  async function signInLink() {
    if (!identity) return reply(botText(locale, 'notLinked'), portalButton(locale));
    const limit = await consumeRateLimit(rateKey('telegram-login:account', externalId), RATE_RULES.loginLinkPerTelegram);
    if (!limit.allowed) return reply(botText(locale, 'loginTooOften', { minutes: String(Math.max(1, Math.ceil(limit.retryAfterSec / 60))) }));
    const created = await createLoginCode(externalId);
    if (!created) return reply(botText(locale, 'loginNoAccess'), portalButton(locale));
    const url = new URL(`/${locale}/login/tg`, getEnv().HUB_URL);
    url.searchParams.set('token', created.token);
    return reply(botText(locale, 'loginLink', { minutes: String(LOGIN_BOT_LINK_TTL_SEC / 60) }), {
      linkButton: { text: botText(locale, 'buttonSignIn'), url: url.toString() },
    });
  }

  if (callback) {
    // Снять ожидание на кнопке. Если не получилось, ответ ниже всё равно уйдёт.
    await bot.answerCallback(callback.id).catch(() => {});
    const data = callback.data ?? '';
    if (data === 'login') return signInLink();
    if (data === 'unlink') return unlink();
    if (data === 'lang') return chooseLanguage();
    if (data.startsWith('lang:')) return setLanguage(data.slice('lang:'.length));
    return fallback();
  }

  const [rawCommand = '', argument] = (message?.text ?? '').trim().split(/\s+/, 2);
  // Команда в группе приходит как /start@имя_бота: имя бота отбрасывается.
  const command = rawCommand.split('@')[0];
  if (command === '/start' && argument) return link(argument);
  if (command === '/login') return signInLink();
  if (command === '/unlink') return unlink();
  if (command === '/lang') return chooseLanguage();
  return fallback();
}

// --- Запасной вход из бота (задача 17, FR-ID-14, угроза T30) ---

/**
 * Нажатие "Войти" на странице ссылки из бота. Сама ссылка ничего не меняет: Telegram открывает ссылки
 * для предпросмотра. Недействительная, просроченная, использованная ссылка и снятый доступ дают один ответ.
 */
export async function completeTelegramLogin(
  input: unknown,
  request: RequestInfo,
): Promise<{ ok: true; next: string } | { ok: false; code: 'link_invalid' }> {
  const raw = (typeof input === 'object' && input !== null ? input : {}) as Record<string, unknown>;
  const locale: Locale = typeof raw.locale === 'string' && isLocale(raw.locale) ? raw.locale : 'ru';
  const token = tokenInput.safeParse(raw.token);
  if (!token.success) return { ok: false, code: 'link_invalid' };
  const userId = await consumeLoginCode(hashToken(token.data), clientIp(request.headers));
  if (!userId) return { ok: false, code: 'link_invalid' };
  await createTrustedSession(userId, 'telegram', request);
  return { ok: true, next: `/${locale}` };
}

/** Сколько страница входа ждёт имя бота. Имя запоминается после первого ответа Telegram. */
const BOT_LINK_WAIT_MS = 1500;
/** После неответа Telegram страница входа минуту не ждёт имя бота (итоговая проверка M1). */
const BOT_LINK_RETRY_MS = 60_000;

type BotLinkState = { failedAt?: number; pending?: Promise<string | null> };
const botLinkShared = globalThis as typeof globalThis & { __hubBotLink?: BotLinkState };

/** Сбрасывает память о неответе Telegram: для тестов. */
export function resetBotLinkForTests(): void {
  botLinkShared.__hubBotLink = undefined;
}

/**
 * Адрес бота для страницы входа. Пусто, если бот выключен или Telegram не ответил вовремя. Не ответил:
 * минуту страница не ждёт снова, а запрос к Telegram один на все показы (итоговая проверка M1).
 */
export async function getBotLink(waitMs: number = BOT_LINK_WAIT_MS): Promise<string | null> {
  const bot = getTelegramBot();
  if (!bot.enabled) return null;
  const state = (botLinkShared.__hubBotLink ??= {});
  if (state.failedAt !== undefined && Date.now() - state.failedAt < BOT_LINK_RETRY_MS) return null;
  state.pending ??= bot
    .getMe()
    .then(
      (me) => `https://t.me/${me.username}`,
      () => null,
    )
    .then((link) => {
      state.pending = undefined;
      state.failedAt = link === null ? Date.now() : undefined;
      return link;
    });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), waitMs);
  });
  try {
    const link = await Promise.race([state.pending, late]);
    if (link === null) state.failedAt ??= Date.now();
    return link;
  } finally {
    clearTimeout(timer);
  }
}
