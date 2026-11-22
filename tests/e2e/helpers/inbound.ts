import { createHmac, randomUUID } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { type APIRequestContext, expect } from '@playwright/test';
import { E2E_WEBHOOK_SECRET, MAIL_DIR } from '../../../playwright.config';
import { dbRows } from './db';

// Входящее письмо в браузерных тестах (план M4, задача 11): текст кладётся туда, откуда его читает заглушка почты
// (MAIL_FILE_DIR/inbound), событие email.received приходит на вебхук с подписью Svix, разбирает фоновый процесс.

/** Адрес неизвестного отправителя: свой на каждый запуск, чтобы пределы частоты не мешали повторам. */
export const unknownAddress = () => `sender-${randomUUID().slice(0, 8)}@unknown-e2e.test`;

type Letter = { from: string; subject: string; text: string; to?: string[]; headers?: [string, string][]; dmarc?: boolean };

/** Тело события email.received и подписанные заголовки вебхука. Текст письма кладётся для заглушки почты. */
export function webhookOf(letter: Letter): { emailId: string; body: string; headers: Record<string, string> } {
  const emailId = randomUUID();
  const domain = /@([^>\s]+)/.exec(letter.from)?.[1]?.toLowerCase() ?? '';
  // Сервис приёма вписывает итог DMARC сверху (решение 11 вехи M4): тест играет его роль.
  const auth: [string, string][] = letter.dmarc ? [['Authentication-Results', `e2e.inbound.test; dmarc=pass header.from=${domain}`]] : [];
  mkdirSync(join(MAIL_DIR, 'inbound'), { recursive: true });
  writeFileSync(join(MAIL_DIR, 'inbound', `${emailId}.json`), JSON.stringify({ text: letter.text, html: null, headers: [...auth, ...(letter.headers ?? [])] }));
  const body = JSON.stringify({
    type: 'email.received',
    created_at: new Date().toISOString(),
    data: { email_id: emailId, from: letter.from, to: letter.to ?? ['support@reply.e2e.test'], cc: [], subject: letter.subject, message_id: `<${emailId}@mail.e2e.test>` },
  });
  const id = `msg_${randomUUID()}`;
  const timestamp = String(Math.floor(Date.now() / 1000));
  const key = Buffer.from(E2E_WEBHOOK_SECRET.slice('whsec_'.length), 'base64');
  const signature = createHmac('sha256', key).update(`${id}.${timestamp}.${body}`).digest('base64');
  return { emailId, body, headers: { 'content-type': 'application/json', 'svix-id': id, 'svix-timestamp': timestamp, 'svix-signature': `v1,${signature}` } };
}

/** Итог разбора письма фоновым процессом: классификация и номер обращения, если оно есть. */
export async function intakeOf(emailId: string): Promise<{ classification: string; number: number | null }> {
  let found: { classification: string; number: number | null } = { classification: '', number: null };
  await expect
    .poll(
      async () => {
        const rows = await dbRows<{ classification: string | null; number: string | null }>(
          `select i.classification, t.number from hdn_email_inbound i left join hdt_tickets t on t.ticket_id = i.ticket_id where i.provider_id = $1 and i.processed_on is not null`,
          [emailId],
        );
        found = { classification: rows[0]?.classification ?? '', number: rows[0]?.number ? Number(rows[0].number) : null };
        return found.classification;
      },
      { timeout: 30_000 },
    )
    .not.toBe('');
  return found;
}

/** Письмо на адрес поддержки. Ждёт, пока фоновый процесс разберёт его, и возвращает номер обращения. */
export async function sendLetter(request: APIRequestContext, letter: Letter): Promise<number> {
  const { emailId, body, headers } = webhookOf(letter);
  const response = await request.post('/api/webhooks/email', { data: body, headers });
  expect(response.status()).toBe(200);
  const { number } = await intakeOf(emailId);
  expect(number).not.toBeNull();
  return number as number;
}

type Outgoing = { to: string; subject: string; text: string; replyTo?: string };

/** Письмо очереди на адрес, подходящее под условие: ждёт его до 30 секунд (отправляет фоновый процесс). */
export async function outboxMail(to: string, match: (mail: Outgoing) => boolean): Promise<Outgoing> {
  let found: Outgoing | undefined;
  await expect
    .poll(
      () => {
        let files: string[] = [];
        try {
          files = readdirSync(MAIL_DIR).filter((name) => name.endsWith('.json'));
        } catch {
          return false;
        }
        for (const name of files.sort().reverse()) {
          const mail = JSON.parse(readFileSync(join(MAIL_DIR, name), 'utf8')) as Outgoing & { kind?: string };
          if (mail.kind === 'outbox' && mail.to === to && match(mail)) {
            found = mail;
            return true;
          }
        }
        return false;
      },
      { timeout: 30_000 },
    )
    .toBe(true);
  return found as Outgoing;
}

/** Вебхук с подписью и проверка ответа: для случаев, когда обращения быть не должно. */
export async function postWebhook(request: APIRequestContext, letter: Letter, opts: { badSignature?: boolean } = {}): Promise<{ status: number; emailId: string }> {
  const { emailId, body, headers } = webhookOf(letter);
  const signed = opts.badSignature ? { ...headers, 'svix-signature': 'v1,AAAA' } : headers;
  const response = await request.post('/api/webhooks/email', { data: body, headers: signed });
  return { status: response.status(), emailId };
}
