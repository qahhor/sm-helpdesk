import 'server-only';
import { createHash, timingSafeEqual } from 'node:crypto';
import { getEnv } from '@/env';

// Клиент Telegram Bot API (задача 16, решение 0018). Без токена бот выключен: портал работает без него,
// раздел "Каналы связи" не показывается. Запросы: POST <TELEGRAM_API_URL>/bot<токен>/<метод> с телом JSON.
// Токен не попадает ни в журнал, ни в текст ошибок.

export type SendOptions = {
  /** Кнопка-ссылка под сообщением. */
  linkButton?: { text: string; url: string };
  /** Кнопки выбора в одну строку: нажатие присылает боту data. */
  choices?: { text: string; data: string }[];
  /** Клавиатура вместо обычной: строки кнопок с текстом. */
  keyboard?: string[][];
};

export interface TelegramBot {
  readonly enabled: boolean;
  getMe(): Promise<{ username: string }>;
  sendMessage(chatId: string, text: string, opts?: SendOptions): Promise<void>;
  setWebhook(url: string, secret: string): Promise<void>;
  /** Ответ на нажатие кнопки: снимает ожидание на кнопке у человека. */
  answerCallback(callbackId: string): Promise<void>;
  /** Заголовок x-telegram-bot-api-secret-token совпадает с секретом вебхука. Сравнение за постоянное время. */
  checkSecret(header: string | null): boolean;
}

/** Ошибка Bot API без токена и без текста сообщения: метод и код ответа. */
export class TelegramError extends Error {
  readonly status: number | null;

  constructor(method: string, status: number | null) {
    super(status === null ? `Telegram не ответил на ${method}` : `Telegram ответил ${status} на ${method}`);
    this.name = 'TelegramError';
    this.status = status;
  }
}

const DEFAULT_TIMEOUT_MS = 5000;
const digest = (value: string) => createHash('sha256').update(value).digest();

function replyMarkup(opts: SendOptions): Record<string, unknown> | undefined {
  const rows: Record<string, string>[][] = [];
  if (opts.linkButton) rows.push([{ text: opts.linkButton.text, url: opts.linkButton.url }]);
  if (opts.choices?.length) rows.push(opts.choices.map((choice) => ({ text: choice.text, callback_data: choice.data })));
  if (rows.length > 0) return { inline_keyboard: rows };
  if (opts.keyboard?.length)
    return { keyboard: opts.keyboard.map((row) => row.map((text) => ({ text }))), resize_keyboard: true, one_time_keyboard: true };
  return undefined;
}

type Config = { token?: string; secret?: string; apiUrl: string; fetch?: typeof fetch; timeoutMs?: number };

export function createTelegramBot(cfg: Config): TelegramBot {
  const token = cfg.token;
  const secret = cfg.secret;
  const doFetch = cfg.fetch ?? fetch;
  const timeoutMs = cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  let username: string | null = null;

  async function call<T = unknown>(method: string, body: Record<string, unknown>): Promise<T> {
    if (!token) throw new TelegramError(method, null);
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new TelegramError(method, null));
      }, timeoutMs);
    });
    const request = (async () => {
      let response: Response;
      try {
        response = await doFetch(`${cfg.apiUrl}/bot${token}/${method}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          signal: controller.signal,
        });
      } catch {
        throw new TelegramError(method, null);
      }
      let parsed: { ok?: unknown; result?: unknown };
      try {
        parsed = (await response.json()) as typeof parsed;
      } catch {
        throw new TelegramError(method, response.status);
      }
      if (!response.ok || parsed.ok !== true) throw new TelegramError(method, response.status);
      return parsed.result as T;
    })();
    try {
      return await Promise.race([request, timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    enabled: Boolean(token && secret),
    async getMe() {
      if (username === null) {
        const me = await call<{ username?: unknown }>('getMe', {});
        if (typeof me?.username !== 'string') throw new TelegramError('getMe', null);
        username = me.username;
      }
      return { username };
    },
    async sendMessage(chatId, text, opts = {}) {
      const markup = replyMarkup(opts);
      await call('sendMessage', {
        chat_id: chatId,
        text,
        // Предпросмотр ссылок не нужен: ссылки в сообщениях бота служебные.
        link_preview_options: { is_disabled: true },
        ...(markup ? { reply_markup: markup } : {}),
      });
    },
    async setWebhook(url, webhookSecret) {
      await call('setWebhook', { url, secret_token: webhookSecret, allowed_updates: ['message', 'callback_query'] });
    },
    async answerCallback(callbackId) {
      await call('answerCallbackQuery', { callback_query_id: callbackId });
    },
    checkSecret(header) {
      if (!secret || !header) return false;
      return timingSafeEqual(digest(header), digest(secret));
    },
  };
}

type SentMessage = { chatId: string; text: string } & SendOptions;

/** Бот в памяти для тестов: запоминает отправленное, может отказать один раз. */
export class MemoryTelegramBot implements TelegramBot {
  /** Секрет вебхука бота в памяти. */
  static readonly SECRET = 'memory-bot-webhook-secret-0123456789';
  readonly enabled = true;
  readonly sent: SentMessage[] = [];
  readonly answered: string[] = [];
  readonly webhooks: { url: string; secret: string }[] = [];
  /** Код ответа следующей неудачной отправки; null: Telegram не ответил. undefined: отправка удаётся. */
  private failStatus: number | null | undefined = undefined;

  async getMe() {
    return { username: 'hub_test_bot' };
  }

  async sendMessage(chatId: string, text: string, opts: SendOptions = {}) {
    if (this.failStatus !== undefined) {
      const status = this.failStatus;
      this.failStatus = undefined;
      throw new TelegramError('sendMessage', status);
    }
    this.sent.push({ chatId, text, ...opts });
  }

  async setWebhook(url: string, secret: string) {
    this.webhooks.push({ url, secret });
  }

  async answerCallback(callbackId: string) {
    this.answered.push(callbackId);
  }

  checkSecret(header: string | null) {
    return header !== null && header.length === MemoryTelegramBot.SECRET.length && timingSafeEqual(digest(header), digest(MemoryTelegramBot.SECRET));
  }

  /** Следующая отправка сообщения упадёт: проверка повторной доставки события. */
  failNext(status: number | null = 502) {
    this.failStatus = status;
  }
}

const shared = globalThis as typeof globalThis & { __hubTelegramBot?: TelegramBot; __hubTestTelegramBot?: TelegramBot | null };

/** Бот процесса по настройкам окружения. */
export function getTelegramBot(): TelegramBot {
  if (shared.__hubTestTelegramBot) return shared.__hubTestTelegramBot;
  if (!shared.__hubTelegramBot) {
    const env = getEnv();
    shared.__hubTelegramBot = createTelegramBot({
      token: env.TELEGRAM_BOT_TOKEN,
      secret: env.TELEGRAM_WEBHOOK_SECRET,
      apiUrl: env.TELEGRAM_API_URL,
    });
  }
  return shared.__hubTelegramBot;
}

/** Подменяет бота в тестах. null возвращает бота по настройкам. */
export function setTelegramBotForTests(bot: TelegramBot | null): void {
  shared.__hubTestTelegramBot = bot;
}
