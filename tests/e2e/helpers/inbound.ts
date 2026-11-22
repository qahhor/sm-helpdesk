import { createHmac, randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { type APIRequestContext, expect } from '@playwright/test';
import { E2E_WEBHOOK_SECRET, MAIL_DIR } from '../../../playwright.config';
import { dbRows } from './db';

// Входящее письмо в браузерных тестах (план M4, задача 11): текст кладётся туда, откуда его читает заглушка почты
// (MAIL_FILE_DIR/inbound), событие email.received приходит на вебхук с подписью Svix, разбирает фоновый процесс.

/** Адрес неизвестного отправителя: свой на каждый запуск, чтобы пределы частоты не мешали повторам. */
export const unknownAddress = () => `sender-${randomUUID().slice(0, 8)}@unknown-e2e.test`;

/** Письмо на адрес поддержки. Ждёт, пока фоновый процесс создаст обращение, и возвращает его номер. */
export async function sendLetter(request: APIRequestContext, letter: { from: string; subject: string; text: string }): Promise<number> {
  const emailId = randomUUID();
  mkdirSync(join(MAIL_DIR, 'inbound'), { recursive: true });
  writeFileSync(join(MAIL_DIR, 'inbound', `${emailId}.json`), JSON.stringify({ text: letter.text, html: null, headers: [] }));
  const body = JSON.stringify({
    type: 'email.received',
    created_at: new Date().toISOString(),
    data: { email_id: emailId, from: letter.from, to: ['support@reply.e2e.test'], cc: [], subject: letter.subject, message_id: `<${emailId}@mail.e2e.test>` },
  });
  const id = `msg_${randomUUID()}`;
  const timestamp = String(Math.floor(Date.now() / 1000));
  const key = Buffer.from(E2E_WEBHOOK_SECRET.slice('whsec_'.length), 'base64');
  const signature = createHmac('sha256', key).update(`${id}.${timestamp}.${body}`).digest('base64');
  const response = await request.post('/api/webhooks/email', {
    data: body,
    headers: { 'content-type': 'application/json', 'svix-id': id, 'svix-timestamp': timestamp, 'svix-signature': `v1,${signature}` },
  });
  expect(response.status()).toBe(200);
  let number = 0;
  await expect
    .poll(
      async () => {
        const rows = await dbRows<{ number: string }>(
          `select t.number from hdn_email_inbound i join hdt_tickets t on t.ticket_id = i.ticket_id where i.provider_id = $1`,
          [emailId],
        );
        number = Number(rows[0]?.number ?? 0);
        return number;
      },
      { timeout: 30_000 },
    )
    .toBeGreaterThan(0);
  return number;
}
