import 'server-only';
import { randomUUID } from 'node:crypto';
import * as z from 'zod';
import { createGuardedFetch } from '@/security/outbound';
import type { Mailer, MailMessage } from './mailer';
import { assertEmailId, type EmailProvider, headerPairs, type InboundAttachment, verifyAndParse } from './provider';

// Настоящая отправка писем через Resend (решение 0018, пункт 17). Письма в M1 только текстовые
// и уходят сразу, без очереди: очередь в одной транзакции с действием (FR-NT-09) и оформленные шаблоны
// появятся в M4. Потерянную ссылку человек запрашивает заново.

const ENDPOINT = 'https://api.resend.com/emails';
const DEFAULT_TIMEOUT_MS = 5000;
/** Скачивание вложения (до 25 МБ) получает больше времени, чем запрос к API: 12 пределов запроса, по умолчанию минута. */
const DOWNLOAD_TIMEOUT_FACTOR = 12;
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
      body: JSON.stringify({ from: cfg.from, to: [message.to], subject: message.subject, text: message.text, ...(message.html && { html: message.html }) }),
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

type ProviderConfig = Config & {
  webhookSecret?: string;
  now?: () => Date;
  /** Узлы, с которых скачиваются вложения писем: сам узел или его поддомен. По умолчанию узел почтового сервиса. */
  downloadHosts?: readonly string[];
};

/** Вложения Resend отдаёт с inbound-cdn.resend.com (справочник Received Emails API). */
export const DEFAULT_DOWNLOAD_HOSTS = ['resend.com'] as const;
/** Сколько переадресаций внутри доверенных узлов проходит скачивание вложения. */
const MAX_DOWNLOAD_REDIRECTS = 3;

/** Узел из списка доверенных: совпадает с записью или её поддомен. */
function trustedHost(host: string, allowed: readonly string[]): boolean {
  return allowed.some((entry) => host === entry || host.endsWith(`.${entry}`));
}

/**
 * Ссылка на вложение, по которой портал согласен идти (аудит 23.11.2026, находка S15): https, без имени и пароля,
 * узел из списка доверенных. Ссылку присылает почтовый сервис, но подменённая ссылка или переадресация не должны
 * заставить сервер портала скачать чужой адрес. В сообщении об ошибке только узел: в адресе подпись доступа.
 */
function checkedDownloadUrl(raw: string, allowed: readonly string[]): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('почта: ссылка на вложение не разбирается');
  }
  if (url.protocol !== 'https:') throw new Error('почта: ссылка на вложение не https');
  const host = url.hostname.replace(/\.$/, '').toLowerCase();
  if (url.username || url.password || !trustedHost(host, allowed)) {
    console.error(`Почта: вложение не скачано, узел ${host.slice(0, 120)} не из списка доверенных (INBOUND_DOWNLOAD_HOSTS)`);
    throw new Error('почта: узел вложения не из списка доверенных');
  }
  return url;
}

export function createResendProvider(cfg: ProviderConfig): EmailProvider {
  const doFetch = cfg.fetch ?? fetch;
  // Вложения идут через сетевой слой с проверкой адреса при соединении: узел из списка доверенных не должен
  // привести во внутреннюю сеть и через DNS. cfg.fetch подменяет оба пути в тестах.
  const downloadFetch = cfg.fetch ?? createGuardedFetch({ allowLoopback: false });
  const downloadHosts = cfg.downloadHosts ?? DEFAULT_DOWNLOAD_HOSTS;
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
      let target = checkedDownloadUrl(url, downloadHosts);
      // Предел времени на весь ответ, включая чтение тела (M4, мелкое 13): тело, которое не кончается,
      // не держит разбор письма. По истечении чтение отменяется, вложение считается не скачанным.
      const controller = new AbortController();
      let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
      const timer = setTimeout(() => {
        controller.abort();
        void reader?.cancel().catch(() => undefined);
      }, timeoutMs * DOWNLOAD_TIMEOUT_FACTOR);
      const chunks: Uint8Array[] = [];
      let total = 0;
      try {
        let response: Response | null = null;
        for (let hop = 0; ; hop++) {
          // Переадресацию портал разбирает сам: каждый следующий адрес проходит ту же проверку узла.
          response = await downloadFetch(target, { method: 'GET', redirect: 'manual', signal: controller.signal }).catch(() => null);
          const location = response && response.status >= 300 && response.status < 400 ? response.headers.get('location') : null;
          if (!response || !location) break;
          await response.body?.cancel().catch(() => undefined);
          if (hop >= MAX_DOWNLOAD_REDIRECTS) throw new Error('почта: слишком много переадресаций вложения');
          target = checkedDownloadUrl(new URL(location, target).toString(), downloadHosts);
        }
        if (!response?.ok || !response.body) throw new MailError(response?.status ?? null);
        const declared = Number(response.headers.get('content-length') ?? '0');
        if (declared > maxBytes) throw new Error('почта: вложение больше предела');
        reader = response.body.getReader();
        for (;;) {
          // Обрыв связи посреди тела: ошибка, а не обрезанный файл (итоговая проверка M4b, I4).
          const { done, value } = await reader.read().catch(() => {
            throw new MailError(null);
          });
          if (controller.signal.aborted) throw new MailError(null);
          if (done) break;
          total += value.byteLength;
          if (total > maxBytes) {
            await reader.cancel();
            throw new Error('почта: вложение больше предела');
          }
          chunks.push(value);
        }
      } finally {
        clearTimeout(timer);
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
