import 'server-only';
import { createHmac, randomUUID } from 'node:crypto';
import type { EmailProvider, InboundAttachment, InboundContent, OutgoingEmail } from './provider';
import { verifyAndParse } from './provider';

// Модуль hdn: заглушки внешних сервисов для тестов (CLAUDE.md: интерфейс, настоящая реализация и заглушка).
// Не слой api: страницы и другие модули их не видят (правило линтера), их берут только тесты (проверка main, Q15).

export { MemoryMailer, setMailerForTests } from './mailer';
export { setInboundAuthservForTests } from './inbound/auth-results';
export { setReplyConfigForTests } from './inbound/reply-address';
export { setEmailProviderForTests } from './provider';
export { MemoryTelegramBot, setTelegramBotForTests } from './telegram';

/** Секрет вебхука заглушки: тот же формат, что у Resend. */
export const MEMORY_WEBHOOK_SECRET = `whsec_${Buffer.alloc(24, 1).toString('base64')}`;

export type MemoryEmailProvider = EmailProvider & {
  readonly sent: { message: OutgoingEmail; idempotencyKey: string }[];
  /** Письмо, которое отдаст fetchInbound, и его вложения (содержимое по downloadUrl). */
  inbound(emailId: string, content: InboundContent, attachments: (InboundAttachment & { data?: Uint8Array })[]): void;
  /** Тело и заголовки запроса вебхука с верной подписью Svix. */
  signedRequest(event: unknown): { body: string; headers: Headers };
  /** Следующие отправки падают с этой ошибкой, пока не вызван failSends(null). */
  failSends(error: Error | null): void;
};

export function createMemoryEmailProvider(secret = MEMORY_WEBHOOK_SECRET): MemoryEmailProvider {
  const sent: { message: OutgoingEmail; idempotencyKey: string }[] = [];
  const contents = new Map<string, InboundContent>();
  const attachments = new Map<string, InboundAttachment[]>();
  const files = new Map<string, Uint8Array>();
  let failure: Error | null = null;
  return {
    sent,
    async send(message, idempotencyKey) {
      if (failure) throw failure;
      sent.push({ message, idempotencyKey });
      return { providerId: `memory-${idempotencyKey}` };
    },
    async verifyWebhook(rawBody, headers) {
      return verifyAndParse(secret, rawBody, headers);
    },
    async fetchInbound(emailId) {
      const content = contents.get(emailId);
      if (!content) throw new Error(`заглушка почты: нет письма ${emailId}`);
      return content;
    },
    async listInboundAttachments(emailId) {
      return attachments.get(emailId) ?? [];
    },
    async download(url, maxBytes) {
      const data = files.get(url);
      if (!data) throw new Error('заглушка почты: нет файла');
      if (data.byteLength > maxBytes) throw new Error('почта: вложение больше предела');
      return data;
    },
    inbound(emailId, content, list) {
      contents.set(emailId, content);
      attachments.set(
        emailId,
        list.map(({ data, ...attachment }) => {
          if (data) files.set(attachment.downloadUrl, data);
          return attachment;
        }),
      );
    },
    signedRequest(event) {
      const body = JSON.stringify(event);
      const id = `msg_${randomUUID()}`;
      const timestamp = String(Math.floor(Date.now() / 1000));
      const key = Buffer.from(secret.slice('whsec_'.length), 'base64');
      const signature = createHmac('sha256', key).update(`${id}.${timestamp}.${body}`).digest('base64');
      return { body, headers: new Headers({ 'svix-id': id, 'svix-timestamp': timestamp, 'svix-signature': `v1,${signature}` }) };
    },
    failSends(error) {
      failure = error;
    },
  };
}
