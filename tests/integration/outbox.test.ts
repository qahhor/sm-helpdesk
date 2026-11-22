import { afterEach, beforeEach, expect, test } from 'vitest';
import { withActor } from '@/db/with-actor';
import { dispatchOutbox, enqueueTx, OUTBOX_RETRY_MINUTES, type OutboxItem, recordDelivery } from '@/modules/hdn/api/outbox';
import { MailError } from '@/modules/hdn/resend';
import { replyAddress } from '@/modules/hdn/inbound/reply-address';
import { createMemoryEmailProvider, type MemoryEmailProvider, setReplyConfigForTests } from '@/modules/hdn/testing';
import { asActor, pools } from './helpers/db';
import { type Fixture, seedTwoOrgs } from './isolation/fixture';

// Очередь исходящих (FR-NT-09, решения 1 и 2 вехи M4): письмо ставится в транзакции действия и уходит после
// фиксации, один раз, с повторами при сбое; адрес и язык получателя берутся в момент отправки.

const SYSTEM = { type: 'system', job: 'outbox.dispatch' } as const;
const MINUTE = 60_000;
let provider: MemoryEmailProvider;
let f: Fixture;

beforeEach(async () => {
  provider = createMemoryEmailProvider();
  f = await seedTwoOrgs();
  await pools.root.query(`update auth."user" set email = 'a-user@example.uz', "emailVerified" = true, locale = 'uz' where id = $1`, [f.aUser.userId]);
});
afterEach(() => provider.failSends(null));

const reply = (): OutboxItem => ({
  channel: 'email',
  recipient: { kind: 'user', userId: f.aUser.userId },
  template: 'ticket_reply',
  payload: { template: 'ticket_reply', number: f.tickets.aOrg.number, title: f.tickets.aOrg.title, url: `/tickets/${f.tickets.aOrg.number}`, body: 'Проверьте настройки печати.' },
  ticketId: f.tickets.aOrg.ticketId,
  locale: 'ru',
});
const row = (id: string) => pools.root.query(`select status, attempts, next_attempt_on, external_id, recipient, last_error from hdn_outbox where outbox_id = $1`, [id]).then((r) => r.rows[0]);

test('письмо в транзакции, которая откатилась, не отправляется', async () => {
  await expect(
    withActor(f.l1.actor, async (tx) => {
      await enqueueTx(tx, reply());
      throw new Error('откат');
    }),
  ).rejects.toThrow('откат');
  expect((await pools.root.query(`select count(*)::int as n from hdn_outbox where status = 'queued'`)).rows[0].n).toBe(0);
  expect(await dispatchOutbox(SYSTEM, new Date(), provider)).toEqual({ sent: 0, failed: 0, skipped: 0 });
  expect(provider.sent).toEqual([]);
});

test('письмо уходит только после фиксации и один раз при двух параллельных отправках', async () => {
  const id = await withActor(f.l1.actor, (tx) => enqueueTx(tx, reply()));
  const now = new Date();
  const [a, b] = await Promise.all([dispatchOutbox(SYSTEM, now, provider), dispatchOutbox(SYSTEM, now, provider)]);
  expect(a.sent + b.sent).toBe(1);
  expect(provider.sent).toHaveLength(1);
  const [{ message, idempotencyKey }] = provider.sent as [(typeof provider.sent)[number]];
  expect(idempotencyKey).toBe(id);
  expect(message.to).toBe('a-user@example.uz');
  expect(message.subject).toBe(`[SUP-${f.tickets.aOrg.number}] ${f.tickets.aOrg.title}`);
  // Язык получателя (uz), а не язык обращения, и ссылка с этим языком.
  expect(message.text).toContain(`/uz/tickets/${f.tickets.aOrg.number}`);
  expect(message.headers?.['Auto-Submitted']).toBe('auto-generated');
  expect(message.headers?.['X-Auto-Response-Suppress']).toBe('All');
  expect(message.headers?.['Message-ID']).toMatch(new RegExp(`^<${id}@`));
  expect(await row(id)).toMatchObject({ status: 'sent', attempts: 1, external_id: `memory-${id}`, recipient: 'a-user@example.uz' });
  // Повторный запуск ничего не шлёт.
  await dispatchOutbox(SYSTEM, new Date(now.getTime() + 10 * MINUTE), provider);
  expect(provider.sent).toHaveLength(1);
});

test('сбой сервиса: повтор через 1 минуту, после шестой неудачи failed', async () => {
  const id = await withActor(f.l1.actor, (tx) => enqueueTx(tx, reply()));
  provider.failSends(new MailError(503));
  let now = new Date();
  expect((await dispatchOutbox(SYSTEM, now, provider)).failed).toBe(0);
  let state = await row(id);
  expect(state).toMatchObject({ status: 'queued', attempts: 1, last_error: 'код 503' });
  expect(state.next_attempt_on.getTime()).toBe(now.getTime() + OUTBOX_RETRY_MINUTES[0]! * MINUTE);
  // До срока повтора строка не берётся.
  await dispatchOutbox(SYSTEM, new Date(now.getTime() + 30_000), provider);
  expect((await row(id)).attempts).toBe(1);
  for (const pause of OUTBOX_RETRY_MINUTES) {
    now = new Date(now.getTime() + pause * MINUTE);
    await dispatchOutbox(SYSTEM, now, provider);
  }
  state = await row(id);
  expect(state).toMatchObject({ status: 'failed', attempts: 6, last_error: 'код 503' });
  expect(provider.sent).toEqual([]);
});

test('процесс упал после отправки: повтор идёт с тем же ключом идемпотентности', async () => {
  const id = await withActor(f.l1.actor, (tx) => enqueueTx(tx, reply()));
  await dispatchOutbox(SYSTEM, new Date(), provider);
  // Отметка "отправлено" не записалась: строка снова в очереди после срока захвата.
  await pools.root.query(`update hdn_outbox set status = 'queued', external_id = null, next_attempt_on = now() - interval '1 minute' where outbox_id = $1`, [id]);
  await dispatchOutbox(SYSTEM, new Date(), provider);
  expect(provider.sent.map((s) => s.idempotencyKey)).toEqual([id, id]);
});

test('получатель без подтверждённого адреса: skipped', async () => {
  const id = await withActor(f.l1.actor, (tx) => enqueueTx(tx, { ...reply(), recipient: { kind: 'user', userId: f.bUser.userId } }));
  expect(await dispatchOutbox(SYSTEM, new Date(), provider)).toEqual({ sent: 0, failed: 0, skipped: 1 });
  expect(await row(id)).toMatchObject({ status: 'skipped' });
  expect(provider.sent).toEqual([]);
});

test('адрес сменили после постановки: письмо уходит на новый', async () => {
  await withActor(f.l1.actor, (tx) => enqueueTx(tx, reply()));
  await pools.root.query(`update auth."user" set email = 'new-address@example.uz' where id = $1`, [f.aUser.userId]);
  await dispatchOutbox(SYSTEM, new Date(), provider);
  expect(provider.sent.map((s) => s.message.to)).toEqual(['new-address@example.uz']);
});

test('событие bounced ставит failed с причиной, delivered ставит delivered', async () => {
  const first = await withActor(f.l1.actor, (tx) => enqueueTx(tx, reply()));
  const second = await withActor(f.l1.actor, (tx) => enqueueTx(tx, reply()));
  await dispatchOutbox(SYSTEM, new Date(), provider);
  await recordDelivery(SYSTEM, { kind: 'delivery', emailId: `memory-${first}`, status: 'bounced', reason: 'Mailbox does not exist' });
  await recordDelivery(SYSTEM, { kind: 'delivery', emailId: `memory-${second}`, status: 'delivered', reason: null });
  // Запоздалое "отправлено" не отменяет "доставлено".
  await recordDelivery(SYSTEM, { kind: 'delivery', emailId: `memory-${second}`, status: 'sent', reason: null });
  expect(await row(first)).toMatchObject({ status: 'failed', last_error: 'bounced: Mailbox does not exist' });
  expect(await row(second)).toMatchObject({ status: 'delivered' });
  // Неизвестный идентификатор ничего не меняет и не бросает.
  await recordDelivery(SYSTEM, { kind: 'delivery', emailId: 'unknown-id', status: 'bounced', reason: null });
});

test('клиент не видит строк очереди и не ставит письмо по чужому обращению', async () => {
  await withActor(f.aUser.actor, (tx) => enqueueTx(tx, reply()));
  expect(await asActor(pools.app, f.aUser.actor, (c) => c.query(`select count(*)::int as n from hdn_outbox`).then((r) => r.rows[0].n))).toBe(0);
  expect(await asActor(pools.app, f.l1.actor, (c) => c.query(`select count(*)::int as n from hdn_outbox where status = 'queued'`).then((r) => r.rows[0].n))).toBe(1);
  await expect(withActor(f.aUser.actor, (tx) => enqueueTx(tx, { ...reply(), ticketId: f.tickets.bOrg.ticketId }))).rejects.toThrow();
  await expect(withActor(f.aUser.actor, (tx) => enqueueTx(tx, { ...reply(), ticketId: undefined }))).rejects.toThrow();
  // Сотрудник читает, но не меняет строки: отправку ведёт система.
  await expect(asActor(pools.app, f.l1.actor, (c) => c.query(`update hdn_outbox set status = 'sent'`).then((r) => r.rowCount))).resolves.toBe(0);
});

test('письмо клиенту об обращении несёт подписанный адрес ответа, письмо дежурным нет', async () => {
  const cfg = { domain: 'reply.example.test', secret: 'reply-secret-of-at-least-32-chars!!' };
  setReplyConfigForTests(cfg);
  try {
    await withActor(f.l1.actor, (tx) => enqueueTx(tx, reply()));
    await pools.root.query(`insert into hdc_settings (code, value) values ('notify.oncall_emails', '["duty@example.uz"]')`);
    await withActor(f.l1.actor, (tx) =>
      enqueueTx(tx, {
        channel: 'email',
        recipient: { kind: 'oncall' },
        template: 'oncall_p1',
        payload: { template: 'oncall_p1', number: f.tickets.aOrg.number, title: 't', url: '/agent/tickets/SUP-1', orgName: 'ACME' },
        ticketId: f.tickets.aOrg.ticketId,
      }),
    );
    await dispatchOutbox(SYSTEM, new Date(), provider);
    const toClient = provider.sent.find((s) => s.message.to === 'a-user@example.uz');
    expect(toClient?.message.replyTo).toBe(replyAddress(f.tickets.aOrg.number, f.aUser.userId, cfg));
    expect(toClient?.message.headers?.['Message-ID']).toMatch(/@reply\.example\.test>$/);
    expect(provider.sent.find((s) => s.message.to === 'duty@example.uz')?.message.replyTo).toBeUndefined();
  } finally {
    setReplyConfigForTests(undefined);
  }
});
