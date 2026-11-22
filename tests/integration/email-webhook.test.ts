import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { MemoryJobQueue, setJobQueueForTests } from '@/modules/hdc/testing';
import { handleEmailWebhook } from '@/modules/hdn/api/webhook-email';
import { createMemoryEmailProvider, type MemoryEmailProvider, setEmailProviderForTests } from '@/modules/hdn/testing';
import { pools } from './helpers/db';
import { seedTwoOrgs } from './isolation/fixture';

// Вебхук почты (раздел 12.2 "POST /api/webhooks/email", решение 10 вехи M4): подпись Svix, строка входящих и задача
// разбора для письма, статус очереди для события доставки. Без подписи ничего не пишется.

const fixture = (name: string) => JSON.parse(readFileSync(join(import.meta.dirname, '../fixtures/resend', name), 'utf8'));
let provider: MemoryEmailProvider;
let jobs: MemoryJobQueue;
beforeEach(() => {
  provider = createMemoryEmailProvider();
  setEmailProviderForTests(provider);
  jobs = new MemoryJobQueue();
  setJobQueueForTests(jobs);
});
afterEach(() => {
  setEmailProviderForTests(null);
  setJobQueueForTests(null);
});

const post = (body: string, headers: Headers) => handleEmailWebhook(new Request('http://localhost:3000/api/webhooks/email', { method: 'POST', body, headers }));
const inboundCount = () => pools.root.query(`select count(*)::int as n from hdn_email_inbound`).then((r) => r.rows[0].n as number);

test('вебхук без подписи и с чужой подписью: 401, строк нет', async () => {
  const event = fixture('email-received.json');
  const unsigned = await post(JSON.stringify(event), new Headers({ 'content-type': 'application/json' }));
  expect(unsigned.status).toBe(401);
  expect(unsigned.headers.get('content-type')).toContain('application/problem+json');
  const stranger = createMemoryEmailProvider(`whsec_${Buffer.alloc(24, 9).toString('base64')}`).signedRequest(event);
  expect((await post(stranger.body, stranger.headers)).status).toBe(401);
  expect(await inboundCount()).toBe(0);
  expect(jobs.sent).toEqual([]);
});

test('повтор того же письма: одна строка и одна задача', async () => {
  const signed = provider.signedRequest(fixture('email-received.json'));
  expect((await post(signed.body, signed.headers)).status).toBe(200);
  const again = provider.signedRequest(fixture('email-received.json'));
  expect((await post(again.body, again.headers)).status).toBe(200);
  const rows = await pools.root.query(`select provider_id, from_address, from_name, to_addresses, cc_addresses, subject, message_id, classification from hdn_email_inbound`);
  expect(rows.rows).toEqual([
    {
      provider_id: '4ef9a417-02e9-4d39-ad75-9611e0fcc33c',
      from_address: 'ivan@example.uz',
      from_name: 'Ivan Petrov',
      to_addresses: ['support@reply.example.test'],
      cc_addresses: ['ali@example.uz'],
      subject: 'Не могу войти',
      message_id: '<CAJ1234@mail.example.uz>',
      classification: null,
    },
  ]);
  expect(jobs.sent.filter((j) => j.name === 'email.inbound')).toHaveLength(1);
});

test('событие доставки меняет статус очереди', async () => {
  const f = await seedTwoOrgs();
  await pools.root.query(`update hdn_outbox set external_id = '56761188-7520-42d8-8898-ff6fc54ce618' where ticket_id = $1`, [f.tickets.aOrg.ticketId]);
  const signed = provider.signedRequest(fixture('email-bounced.json'));
  expect((await post(signed.body, signed.headers)).status).toBe(200);
  const row = await pools.root.query(`select status, last_error from hdn_outbox where ticket_id = $1`, [f.tickets.aOrg.ticketId]);
  expect(row.rows[0]).toEqual({ status: 'failed', last_error: 'bounced: Mailbox does not exist' });
});

test('неизвестное событие: 200 без записи; тело не по схеме: 400', async () => {
  const ignored = provider.signedRequest({ type: 'contact.created', created_at: '2026-11-22T10:00:00Z', data: {} });
  expect((await post(ignored.body, ignored.headers)).status).toBe(200);
  const broken = provider.signedRequest({ type: 'email.received', data: { from: 'x' } });
  const response = await post(broken.body, broken.headers);
  expect(response.status).toBe(400);
  expect(response.headers.get('content-type')).toContain('application/problem+json');
  expect(await inboundCount()).toBe(0);
});
