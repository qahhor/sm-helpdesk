import { beforeEach, expect, test } from 'vitest';
import { withActor } from '@/db/with-actor';
import { dispatchOutbox, enqueueTx } from '@/modules/hdn/api/outbox';
import type { EmailProvider } from '@/modules/hdn/provider';
import { MailError } from '@/modules/hdn/resend';
import { createMemoryEmailProvider } from '@/modules/hdn/testing';
import { pools } from './helpers/db';
import { deliver as deliverTo, inboundPerTest } from './helpers/inbound';
import { type Fixture, seedTwoOrgs } from './isolation/fixture';

// Долги вехи M4, обещанные в отчёте (план M4b, задача 4): мелкие замечания 2, 4 и 13.

const OUTBOX = { type: 'system', job: 'outbox.dispatch' } as const;
const box = inboundPerTest();
let f: Fixture;
beforeEach(async () => {
  f = await seedTwoOrgs();
});

const oncallRow = () =>
  withActor(OUTBOX, (tx) =>
    enqueueTx(tx, {
      channel: 'email',
      recipient: { kind: 'oncall' },
      template: 'oncall_p1',
      payload: { template: 'oncall_p1', number: f.tickets.aOrg.number, title: 'P1', url: `/agent/tickets/SUP-${f.tickets.aOrg.number}`, orgName: 'ACME' },
      ticketId: f.tickets.aOrg.ticketId,
    }),
  );
const rowOf = (outboxId: string) =>
  pools.root.query(`select status, external_id, last_error from hdn_outbox where outbox_id = $1`, [outboxId]).then((r) => r.rows[0]);

test('итоговая запись строки очереди не перетирает уже отправленную другим процессом (M4, мелкое 2)', async () => {
  await pools.root.query(`insert into hdc_settings (code, value) values ('notify.oncall_emails', '["duty@example.uz"]')`);
  const id = await oncallRow();
  const base = createMemoryEmailProvider();
  // Пока этот процесс отправлял, срок захвата истёк, и строку отправил и отметил другой процесс.
  const provider: EmailProvider = {
    ...base,
    async send(message, key) {
      await pools.root.query(`update hdn_outbox set status = 'sent', external_id = 'other-process' where outbox_id = $1`, [id]);
      return base.send(message, key);
    },
  };
  await dispatchOutbox(OUTBOX, new Date(), provider, null);
  expect(await rowOf(id)).toMatchObject({ status: 'sent', external_id: 'other-process' });
});

test('ошибка одного адреса дежурных не мешает письмам остальным (M4, мелкое 4)', async () => {
  await pools.root.query(`insert into hdc_settings (code, value) values ('notify.oncall_emails', '["a@example.uz", "b@example.uz", "c@example.uz"]')`);
  const id = await oncallRow();
  const base = createMemoryEmailProvider();
  let failB = true;
  const provider: EmailProvider = {
    ...base,
    async send(message, key) {
      if (message.to === 'b@example.uz' && failB) throw new MailError(502);
      return base.send(message, key);
    },
  };
  const now = Date.now();
  await dispatchOutbox(OUTBOX, new Date(now), provider, null);
  expect(base.sent.map((s) => s.message.to)).toEqual(['a@example.uz', 'c@example.uz']);
  expect(await rowOf(id)).toMatchObject({ status: 'queued', last_error: 'код 502' });
  // Повтор строки: тот же ключ у уже отправленных адресов, сервис их не повторит; b получает письмо.
  failB = false;
  await dispatchOutbox(OUTBOX, new Date(now + 2 * 60_000), provider, null);
  expect(base.sent.filter((s) => s.message.to === 'b@example.uz')).toHaveLength(1);
  expect(new Set(base.sent.filter((s) => s.message.to === 'a@example.uz').map((s) => s.idempotencyKey)).size).toBe(1);
  expect((await rowOf(id)).status).toBe('sent');
});

test('имя гостя из поля From без невидимых и управляющих знаков (M4, мелкое 13)', async () => {
  const { inboundId } = await deliverTo(box, { from: '"Bo‮bur​\u0007  Aliev" <bobur@unknown.uz>', subject: 'Вопрос' });
  const name = (
    await pools.root.query(
      `select u.name from hdn_email_inbound i join hdt_tickets t on t.ticket_id = i.ticket_id join auth."user" u on u.id = t.author_id where i.inbound_id = $1`,
      [inboundId],
    )
  ).rows[0].name;
  expect(name).toBe('Bobur Aliev');
});
