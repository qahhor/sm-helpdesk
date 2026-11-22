import 'server-only';
import { randomUUID } from 'node:crypto';
import * as z from 'zod';
import type { Mailer, MailMessage } from './mailer';
import { assertEmailId, type EmailProvider, headerPairs, type InboundAttachment, verifyAndParse } from './provider';

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
      // Журнал пишет queueMail по коду ошибки: адрес, тема, текст со ссылкой и ключ сервиса туда не попадают.
      throw new MailError(status);
    },
  };
}

// Почтовый сервис вехи M4 поверх Resend (раздел 11.11, решения 1, 10 и 20): отправка писем очереди с ключом
// идемпотентности строки, проверка подписи вебхука, письмо и вложения запросами к Received Emails API.

const API = 'https://api.resend.com';

type ProviderConfig = Config & { webhookSecret?: string; now?: () => Date };

export function createResendProvider(cfg: ProviderConfig): EmailProvider {
  const doFetch = cfg.fetch ?? fetch;
  const timeoutMs = cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const pauses = cfg.pausesMs ?? DEFAULT_PAUSES_MS;

  /** Одна попытка с ограничением времени: ответ или null, если ответа не было. */
  async function once(url: string, init: RequestInit): Promise<Response | null> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await doFetch(url, { ...init, signal: controller.signal });
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  /** Запрос с повторами при сбое сети, 429 и 5xx. Остальные ответы не 2xx: MailError с кодом. */
  async function call(path: string, init: RequestInit): Promise<Response> {
    let status: number | null = null;
    for (let round = 0; round <= pauses.length; round++) {
      if (round > 0) await new Promise((done) => setTimeout(done, pauses[round - 1]));
      const response = await once(`${API}${path}`, init);
      status = response?.status ?? null;
      if (response && status !== null && status >= 200 && status < 300) return response;
      if (!retryable(status)) break;
    }
    throw new MailError(status);
  }

  const auth = { Authorization: `Bearer ${cfg.apiKey}` };

  return {
    async send(msg, idempotencyKey) {
      const response = await call('/emails', {
        method: 'POST',
        headers: { ...auth, 'Content-Type': 'application/json', 'Idempotency-Key': idempotencyKey },
        body: JSON.stringify({
          from: cfg.from,
          to: [msg.to],
          subject: msg.subject,
          html: msg.html,
          text: msg.text,
          ...(msg.replyTo && { reply_to: msg.replyTo }),
          ...(msg.headers && Object.keys(msg.headers).length > 0 && { headers: msg.headers }),
        }),
      });
      const body = (await response.json().catch(() => null)) as { id?: unknown } | null;
      return { providerId: typeof body?.id === 'string' ? body.id : idempotencyKey };
    },
    async verifyWebhook(rawBody, headers) {
      return verifyAndParse(cfg.webhookSecret, rawBody, headers, cfg.now?.() ?? new Date());
    },
    async fetchInbound(emailId) {
      const response = await call(`/emails/receiving/${assertEmailId(emailId)}`, { method: 'GET', headers: auth });
      const body = (await response.json()) as { html?: unknown; text?: unknown; headers?: unknown };
      return {
        html: typeof body.html === 'string' ? body.html : null,
        text: typeof body.text === 'string' ? body.text : null,
        headers: headerPairs(body.headers),
      };
    },
    async listInboundAttachments(emailId) {
      const response = await call(`/emails/receiving/${assertEmailId(emailId)}/attachments`, { method: 'GET', headers: auth });
      const body = (await response.json()) as { data?: unknown };
      return attachmentList.parse(body.data ?? []);
    },
    async download(url, maxBytes) {
      if (!url.startsWith('https://')) throw new Error('почта: ссылка на вложение не https');
      const response = await once(url, { method: 'GET' });
      if (!response?.ok || !response.body) throw new MailError(response?.status ?? null);
      const declared = Number(response.headers.get('content-length') ?? '0');
      if (declared > maxBytes) throw new Error('почта: вложение больше предела');
      const chunks: Uint8Array[] = [];
      let total = 0;
      const reader = response.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > maxBytes) {
          await reader.cancel();
          throw new Error('почта: вложение больше предела');
        }
        chunks.push(value);
      }
      const out = new Uint8Array(total);
      let offset = 0;
      for (const chunk of chunks) {
        out.set(chunk, offset);
        offset += chunk.byteLength;
      }
      return out;
    },
  };
}

const attachmentList = z.array(
  z
    .object({
      id: z.string().min(1),
      filename: z.string().nullish(),
      content_type: z.string().nullish(),
      size: z.number().int().nonnegative().nullish(),
      content_id: z.string().nullish(),
      content_disposition: z.string().nullish(),
      download_url: z.string().url(),
    })
    .transform(
      (a): InboundAttachment => ({
        id: a.id,
        filename: a.filename ?? 'attachment',
        contentType: a.content_type ?? 'application/octet-stream',
        size: a.size ?? 0,
        contentId: a.content_id ?? null,
        disposition: a.content_disposition === 'inline' ? 'inline' : 'attachment',
        downloadUrl: a.download_url,
      }),
    ),
);
