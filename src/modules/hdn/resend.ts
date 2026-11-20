import 'server-only';
import { randomUUID } from 'node:crypto';
import type { Mailer, MailMessage } from './mailer';

// Настоящая отправка писем через Resend (решение 0018, пункт 17). Письма в M1 только текстовые
// и уходят сразу, без очереди: очередь в одной транзакции с действием (FR-NT-09) и оформленные шаблоны
// появятся в M4. Потерянную ссылку человек запрашивает заново.

const ENDPOINT = 'https://api.resend.com/emails';
const DEFAULT_TIMEOUT_MS = 5000;
/** Паузы перед повторами: два повтора, через 0,5 и 2 секунды. */
const DEFAULT_PAUSES_MS = [500, 2000];

/** Письмо не ушло. status: код ответа сервиса, null если ответа не было (сеть, время вышло). */
export class MailError extends Error {
  readonly status: number | null;

  constructor(status: number | null) {
    super(status === null ? 'Письмо не отправлено: сервис почты не ответил' : `Письмо не отправлено: сервис почты ответил ${status}`);
    this.name = 'MailError';
    this.status = status;
  }
}

/** Повторять стоит сбой сети, истечение времени, 429 и 5xx. Остальные 4xx это ошибка запроса. */
const retryable = (status: number | null) => status === null || status === 429 || status >= 500;

type Config = { apiKey: string; from: string; fetch?: typeof fetch; timeoutMs?: number; pausesMs?: number[] };

export function createResendMailer(cfg: Config): Mailer {
  const doFetch = cfg.fetch ?? fetch;
  const timeoutMs = cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const pauses = cfg.pausesMs ?? DEFAULT_PAUSES_MS;

  /** Одна попытка: код ответа, null если ответа не было. */
  async function attempt(message: MailMessage, idempotencyKey: string): Promise<number | null> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<null>((resolve) => {
      timer = setTimeout(() => {
        controller.abort();
        resolve(null);
      }, timeoutMs);
    });
    const request = doFetch(ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${cfg.apiKey}`,
        'Content-Type': 'application/json',
        // Один ключ на письмо во всех повторах: сервис не отправит одно письмо дважды.
        'Idempotency-Key': idempotencyKey,
      },
      body: JSON.stringify({ from: cfg.from, to: [message.to], subject: message.subject, text: message.text }),
      signal: controller.signal,
    })
      .then((response) => response.status)
      .catch(() => null);
    try {
      return await Promise.race([request, timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    delivers: true,
    async send(message) {
      const idempotencyKey = randomUUID();
      let status: number | null = null;
      for (let round = 0; round <= pauses.length; round++) {
        if (round > 0) await new Promise((done) => setTimeout(done, pauses[round - 1]));
        status = await attempt(message, idempotencyKey);
        if (status !== null && status >= 200 && status < 300) return;
        if (!retryable(status)) break;
      }
      // В журнал только вид письма и код ответа: адрес, тема, текст со ссылкой и ключ сервиса туда не попадают.
      console.error(`Письмо ${message.kind} не отправлено через Resend: ${status === null ? 'нет ответа' : `код ${status}`}`);
      throw new MailError(status);
    },
  };
}
