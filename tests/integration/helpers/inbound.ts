import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, expect } from 'vitest';
import { createStubScanner } from '@/modules/hdc/antivirus/stub';
import { MemoryJobQueue, MemoryStorage, setJobQueueForTests, setScannerForTests, setStorageForTests } from '@/modules/hdc/testing';
import { handleEmailWebhook } from '@/modules/hdn/api/webhook-email';
import { createMemoryEmailProvider, type MemoryEmailProvider, setEmailProviderForTests, setInboundAuthservForTests, setReplyConfigForTests } from '@/modules/hdn/testing';
import { intakeEmail } from '@/modules/hdt/api/email-intake';
import { pools } from './db';

// Входящие письма в интеграционных тестах (план M4, задачи 9-11): письмо приходит вебхуком с верной подписью,
// затем его разбирает задача email.inbound. Почтовый сервис, хранилище, антивирус и очередь задач в памяти.

export const SYSTEM = { type: 'system', job: 'email.inbound' } as const;
export const REPLY = { domain: 'reply.example.test', secret: 'reply-secret-of-at-least-32-chars!!' };
export const AUTHSERV = 'inbound.example.test';
export const INTAKE = 'support@reply.example.test';

export type Letter = {
  from?: string;
  to?: string[];
  cc?: string[];
  subject?: string;
  /** null: в письме только HTML. */
  text?: string | null;
  html?: string | null;
  messageId?: string;
  headers?: [string, string][];
  /** Результат DMARC в заголовке сервиса приёма; null: заголовка нет. */
  dmarc?: 'pass' | 'fail' | null;
  attachments?: { filename: string; contentType: string; data: Uint8Array; inline?: boolean }[];
};

export type InboundBox = { provider: MemoryEmailProvider; storage: MemoryStorage; jobs: MemoryJobQueue };

/** Подключает заглушки почты, хранилища, антивируса и очереди к каждому тесту файла. */
export function inboundPerTest(): InboundBox {
  const box = {} as InboundBox;
  beforeEach(() => {
    box.provider = createMemoryEmailProvider();
    setEmailProviderForTests(box.provider);
    setReplyConfigForTests(REPLY);
    setInboundAuthservForTests(AUTHSERV);
    box.storage = new MemoryStorage();
    setStorageForTests(box.storage);
    setScannerForTests(createStubScanner());
    box.jobs = new MemoryJobQueue();
    setJobQueueForTests(box.jobs);
  });
  afterEach(() => {
    setEmailProviderForTests(null);
    setReplyConfigForTests(undefined);
    setInboundAuthservForTests(undefined);
    setStorageForTests(null);
    setScannerForTests(null);
    setJobQueueForTests(null);
  });
  return box;
}

/** Письмо приходит вебхуком, затем его разбирает задача email.inbound. */
export async function deliver(box: InboundBox, letter: Letter): Promise<{ inboundId: string; result: string }> {
  const emailId = randomUUID();
  const from = letter.from ?? 'Anvar <a-user@example.uz>';
  const domain = (from.match(/@([^>]+)/)?.[1] ?? '').toLowerCase();
  const auth: [string, string][] =
    letter.dmarc === null ? [] : [['Authentication-Results', `${AUTHSERV}; dmarc=${letter.dmarc ?? 'pass'} header.from=${domain}`]];
  box.provider.inbound(
    emailId,
    { html: letter.html ?? null, text: letter.text === undefined ? 'Спасибо, заработало' : letter.text, headers: [...auth, ...(letter.headers ?? [])] },
    (letter.attachments ?? []).map((a, i) => ({
      id: `att-${i}`,
      filename: a.filename,
      contentType: a.contentType,
      size: a.data.byteLength,
      contentId: a.inline ? `cid-${i}` : null,
      disposition: a.inline ? 'inline' : 'attachment',
      downloadUrl: `https://inbound.test/${emailId}/${i}`,
      data: a.data,
    })),
  );
  const signed = box.provider.signedRequest({
    type: 'email.received',
    created_at: new Date().toISOString(),
    data: {
      email_id: emailId,
      from,
      to: letter.to ?? [INTAKE],
      cc: letter.cc ?? [],
      subject: letter.subject ?? 'Re: письмо',
      message_id: letter.messageId ?? `<${emailId}@mail.example.uz>`,
    },
  });
  const response = await handleEmailWebhook(new Request('http://localhost:3000/api/webhooks/email', { method: 'POST', body: signed.body, headers: signed.headers }));
  expect(response.status).toBe(200);
  const inboundId = (await pools.root.query(`select inbound_id from hdn_email_inbound where provider_id = $1`, [emailId])).rows[0].inbound_id as string;
  return { inboundId, result: await intakeEmail(SYSTEM, inboundId) };
}

export const ticketCount = () => pools.root.query(`select count(*)::int as n from hdt_tickets`).then((r) => r.rows[0].n as number);
