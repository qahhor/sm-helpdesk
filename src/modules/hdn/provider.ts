import 'server-only';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import * as z from 'zod';
import { type Env, getEnv } from '@/env';
import { verifySvix } from './svix';

// Модуль hdn: почтовый сервис вехи M4 (раздел 11.11 ТЗ). Интерфейс, настоящая реализация (resend.ts) и заглушка
// (testing.ts). Вебхук Resend несёт только сведения о письме: текст, заголовки и вложения забираются отдельными
// запросами (решение 10). Поля взяты из описания API, документация из среды сборки недоступна (решение 0018):
// разбор терпим к форме, неизвестное событие не ошибка.

export type OutgoingEmail = { to: string; subject: string; html: string; text: string; replyTo?: string; headers?: Record<string, string> };

export type DeliveryStatus = 'sent' | 'delivered' | 'delayed' | 'bounced' | 'complained' | 'failed';

export type WebhookEvent =
  | { kind: 'received'; emailId: string; from: string; to: string[]; cc: string[]; subject: string; messageId: string | null; receivedAt: Date }
  | { kind: 'delivery'; emailId: string; status: DeliveryStatus; reason: string | null }
  | { kind: 'ignored'; type: string };

export type ReceivedEvent = Extract<WebhookEvent, { kind: 'received' }>;
export type DeliveryEvent = Extract<WebhookEvent, { kind: 'delivery' }>;

export type InboundContent = { html: string | null; text: string | null; headers: [name: string, value: string][] };

export type InboundAttachment = {
  id: string;
  filename: string;
  contentType: string;
  size: number;
  contentId: string | null;
  disposition: 'attachment' | 'inline';
  downloadUrl: string;
};

export interface EmailProvider {
  /** Отправка. Ключ идемпотентности один на строку очереди: повтор после сбоя не даёт второго письма (решение 1). */
  send(msg: OutgoingEmail, idempotencyKey: string): Promise<{ providerId: string }>;
  /** Проверяет подпись и разбирает событие. Неверная подпись: WebhookSignatureError. */
  verifyWebhook(rawBody: string, headers: Headers): Promise<WebhookEvent>;
  fetchInbound(emailId: string): Promise<InboundContent>;
  listInboundAttachments(emailId: string): Promise<InboundAttachment[]>;
  /** Файл по ссылке сервиса, не больше maxBytes. */
  download(url: string, maxBytes: number): Promise<Uint8Array>;
}

/** Подпись вебхука неверна или её нет: запрос отклоняется без записи. */
export class WebhookSignatureError extends Error {
  constructor() {
    super('Подпись вебхука почты неверна');
    this.name = 'WebhookSignatureError';
  }
}

/** Идентификатор письма у сервиса: попадает в адрес запроса, поэтому только безопасные знаки. */
export const EMAIL_ID = /^[A-Za-z0-9_-]{1,100}$/;

export function assertEmailId(emailId: string): string {
  if (!EMAIL_ID.test(emailId)) throw new Error('почта: недопустимый идентификатор письма');
  return emailId;
}

const ADDRESS = /^[^\s@<>"(),;:]+@[^\s@<>"(),;:]+\.[^\s@<>"(),;:]+$/;

/** Адрес и имя из поля From или To: "Имя <адрес>", "<адрес>" или "адрес". Адрес приводится к строчным буквам. */
export function parseMailbox(value: string): { address: string; name: string | null } | null {
  const text = value.trim();
  const angle = /^(.*)<([^<>]+)>\s*$/.exec(text);
  const address = (angle ? angle[2] : text)?.trim().toLowerCase() ?? '';
  if (!ADDRESS.test(address)) return null;
  const rawName = angle?.[1]?.trim().replace(/^"(.*)"$/, '$1').trim() ?? '';
  return { address, name: rawName === '' ? null : rawName };
}

const addresses = z
  .union([z.string(), z.array(z.string()), z.null()])
  .optional()
  .transform((value) => (value == null ? [] : Array.isArray(value) ? value : [value]));

const receivedData = z.object({
  email_id: z.string().regex(EMAIL_ID),
  created_at: z.string().optional(),
  from: z.string().min(1),
  to: addresses,
  cc: addresses,
  subject: z.string().nullish(),
  message_id: z.string().nullish(),
});

const deliveryData = z.object({
  email_id: z.string().regex(EMAIL_ID),
  bounce: z.object({ message: z.string().nullish() }).partial().nullish(),
  failed: z.object({ reason: z.string().nullish() }).partial().nullish(),
});

const envelope = z.object({ type: z.string().min(1), created_at: z.string().optional(), data: z.unknown() });

const DELIVERY_TYPES: Record<string, DeliveryStatus> = {
  'email.sent': 'sent',
  'email.delivered': 'delivered',
  'email.delivery_delayed': 'delayed',
  'email.bounced': 'bounced',
  'email.complained': 'complained',
  'email.failed': 'failed',
};

/** Разбор тела вебхука после проверки подписи. Тело не по схеме: ошибка разбора (ответ 400). */
export function parseWebhookEvent(rawBody: string): WebhookEvent {
  const event = envelope.parse(JSON.parse(rawBody));
  if (event.type === 'email.received') {
    const data = receivedData.parse(event.data);
    return {
      kind: 'received',
      emailId: data.email_id,
      from: data.from,
      to: data.to,
      cc: data.cc,
      subject: data.subject ?? '',
      messageId: data.message_id ?? null,
      receivedAt: new Date(data.created_at ?? event.created_at ?? Date.now()),
    };
  }
  const status = DELIVERY_TYPES[event.type];
  if (status) {
    const data = deliveryData.parse(event.data);
    return { kind: 'delivery', emailId: data.email_id, status, reason: data.bounce?.message ?? data.failed?.reason ?? null };
  }
  return { kind: 'ignored', type: event.type };
}

/** Проверка подписи Svix по заголовкам запроса и разбор события. */
export function verifyAndParse(secret: string | undefined, rawBody: string, headers: Headers, now = new Date()): WebhookEvent {
  const id = headers.get('svix-id') ?? '';
  const timestamp = headers.get('svix-timestamp') ?? '';
  const signature = headers.get('svix-signature') ?? '';
  if (!secret || !verifySvix(secret, id, timestamp, signature, rawBody, now)) throw new WebhookSignatureError();
  return parseWebhookEvent(rawBody);
}

/** Заголовки письма приходят объектом (значение строка или список) или списком { name, value }: приводятся к парам. */
export function headerPairs(value: unknown): [string, string][] {
  const pairs: [string, string][] = [];
  if (Array.isArray(value)) {
    for (const item of value)
      if (item && typeof item === 'object' && typeof item.name === 'string' && typeof item.value === 'string') pairs.push([item.name, item.value]);
  } else if (value && typeof value === 'object') {
    for (const [name, raw] of Object.entries(value)) {
      if (typeof raw === 'string') pairs.push([name, raw]);
      else if (Array.isArray(raw)) for (const one of raw) if (typeof one === 'string') pairs.push([name, one]);
    }
  }
  return pairs;
}

const inboundFile = z.object({
  html: z.string().nullable().default(null),
  text: z.string().nullable().default(null),
  headers: z.array(z.tuple([z.string(), z.string()])).default([]),
});

/**
 * Почта без Resend: none молчит, console печатает, file кладёт письмо JSON-файлом в MAIL_FILE_DIR (его читают
 * браузерные тесты). Входящие для file лежат в MAIL_FILE_DIR/inbound/<id>.json. Подпись вебхука та же, что у Resend.
 */
function createLocalProvider(env: Pick<Env, 'MAIL_TRANSPORT' | 'MAIL_FILE_DIR' | 'RESEND_WEBHOOK_SECRET'>): EmailProvider {
  const dir = env.MAIL_FILE_DIR;
  return {
    async send(msg, idempotencyKey) {
      if (env.MAIL_TRANSPORT === 'console') console.info(`Письмо очереди\nКому: ${msg.to}\nТема: ${msg.subject}\n\n${msg.text}\n`);
      else if (env.MAIL_TRANSPORT === 'file' && dir) {
        await mkdir(dir, { recursive: true });
        const file = join(dir, `${Date.now()}-${idempotencyKey}.json`);
        await writeFile(file, JSON.stringify({ kind: 'outbox', ...msg, idempotencyKey, sentAt: new Date().toISOString() }, null, 2));
      }
      return { providerId: `local-${idempotencyKey}` };
    },
    async verifyWebhook(rawBody, headers) {
      return verifyAndParse(env.RESEND_WEBHOOK_SECRET, rawBody, headers);
    },
    async fetchInbound(emailId) {
      if (env.MAIL_TRANSPORT !== 'file' || !dir) throw new Error('почта: входящие письма доступны только через Resend');
      return inboundFile.parse(JSON.parse(await readFile(join(dir, 'inbound', `${assertEmailId(emailId)}.json`), 'utf8')));
    },
    async listInboundAttachments() {
      return [];
    },
    async download() {
      throw new Error('почта: скачивание вложений доступно только через Resend');
    },
  };
}

const shared = globalThis as typeof globalThis & { __hubEmailProvider?: EmailProvider; __hubTestEmailProvider?: EmailProvider | null };

/** Почтовый сервис процесса по настройкам окружения. */
export async function getEmailProvider(): Promise<EmailProvider> {
  if (shared.__hubTestEmailProvider) return shared.__hubTestEmailProvider;
  if (!shared.__hubEmailProvider) {
    const env = getEnv();
    if (env.MAIL_TRANSPORT === 'resend') {
      const { createResendProvider } = await import('./resend');
      if (!env.RESEND_API_KEY || !env.MAIL_FROM) throw new Error('RESEND_API_KEY и MAIL_FROM обязательны, а MAIL_TRANSPORT равен resend');
      shared.__hubEmailProvider = createResendProvider({
        apiKey: env.RESEND_API_KEY,
        from: env.MAIL_FROM,
        webhookSecret: env.RESEND_WEBHOOK_SECRET,
        downloadHosts: env.INBOUND_DOWNLOAD_HOSTS?.split(',').map((host) => host.trim()),
      });
    } else shared.__hubEmailProvider = createLocalProvider(env);
  }
  return shared.__hubEmailProvider;
}

/** Подменяет почтовый сервис в тестах. null возвращает сервис по настройкам. */
export function setEmailProviderForTests(provider: EmailProvider | null): void {
  shared.__hubTestEmailProvider = provider;
}
