import 'server-only';
import { getEnv } from '@/env';

// Проверка "не робот" на формах входа (ТЗ 14.5, решение 0018): Cloudflare Turnstile за интерфейсом.
// Без ключей проверка выключена: портал запускается локально без единого внешнего ключа (ТЗ 11.11).
//
// Вердикт:
//   passed       проверка пройдена или выключена;
//   failed       сервис отказал, токен с чужого сайта или токена нет: действие закрывается;
//   unavailable  сервис не ответил: действие не закрывается, действуют ограничения частоты (пункт 16 плана M1).

export type BotVerdict = 'passed' | 'failed' | 'unavailable';

export interface BotCheck {
  readonly enabled: boolean;
  verify(token: unknown, ip: string | null): Promise<BotVerdict>;
}

const SITEVERIFY = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
/** Токен виджета не длиннее 2048 знаков (документация Turnstile). */
const TOKEN_LIMIT = 2048;
const DEFAULT_TIMEOUT_MS = 3000;

type Config = { secret?: string; hostname: string; fetch?: typeof fetch; timeoutMs?: number };

/** Почему сервис недоступен: без данных посетителя, токена и секрета. */
function unavailable(reason: string): BotVerdict {
  console.warn(`Проверка "не робот" недоступна (${reason}): действие продолжается без неё, ограничения частоты действуют`);
  return 'unavailable';
}

export function createBotCheck(cfg: Config): BotCheck {
  const secret = cfg.secret;
  if (!secret) return { enabled: false, verify: async () => 'passed' };
  const doFetch = cfg.fetch ?? fetch;
  const timeoutMs = cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  async function ask(token: string, ip: string | null, signal: AbortSignal): Promise<BotVerdict> {
    const body = new URLSearchParams({ secret: secret as string, response: token });
    if (ip) body.set('remoteip', ip);
    let response: Response;
    try {
      response = await doFetch(SITEVERIFY, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
        signal,
      });
    } catch {
      return unavailable('сеть');
    }
    if (response.status >= 500) return unavailable(`код ${response.status}`);
    let result: { success?: unknown; hostname?: unknown };
    try {
      result = (await response.json()) as typeof result;
    } catch {
      return unavailable('ответ не JSON');
    }
    if (typeof result !== 'object' || result === null) return unavailable('ответ не JSON');
    // Токен, полученный на чужом сайте с нашим ключом, не подходит.
    return result.success === true && result.hostname === cfg.hostname ? 'passed' : 'failed';
  }

  return {
    enabled: true,
    async verify(token, ip) {
      if (typeof token !== 'string' || token.length === 0 || token.length > TOKEN_LIMIT) return 'failed';
      const controller = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<BotVerdict>((resolve) => {
        timer = setTimeout(() => {
          controller.abort();
          resolve(unavailable('время ответа вышло'));
        }, timeoutMs);
      });
      try {
        return await Promise.race([ask(token, ip, controller.signal), timeout]);
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

const shared = globalThis as typeof globalThis & { __hubBotCheck?: BotCheck; __hubTestBotCheck?: BotCheck | null };

/** Проверка процесса по настройкам окружения. */
export function getBotCheck(): BotCheck {
  if (shared.__hubTestBotCheck) return shared.__hubTestBotCheck;
  if (!shared.__hubBotCheck) {
    const env = getEnv();
    shared.__hubBotCheck = createBotCheck({ secret: env.TURNSTILE_SECRET, hostname: env.HUB_DOMAIN });
  }
  return shared.__hubBotCheck;
}

/** Подменяет проверку в тестах. null возвращает проверку по настройкам. */
export function setBotCheckForTests(check: BotCheck | null): void {
  shared.__hubTestBotCheck = check;
}
