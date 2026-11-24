import { beforeEach, expect, test } from 'vitest';
import { contacts, registerContactDirectory } from '@/modules/hdc/contacts';
import { dispatchOutbox } from '@/modules/hdn/api/outbox';
import type { EmailProvider } from '@/modules/hdn/provider';
import { createMemoryEmailProvider, type MemoryEmailProvider } from '@/modules/hdn/testing';
import { countTransactions } from './helpers/bulk';
import { pools } from './helpers/db';
import { type Fixture, seedTwoOrgs } from './isolation/fixture';

// Потолок очереди исходящих (аудит 23.11.2026, находка P7; план W2, задача 2). Раньше запуск отправлял одну пачку
// в 50 писем по одному, раз в минуту: потолок 3000 писем в час, настройки читались на каждое письмо.

const SYSTEM = { type: 'system', job: 'outbox.dispatch' } as const;
let provider: MemoryEmailProvider;
let f: Fixture;

beforeEach(async () => {
  provider = createMemoryEmailProvider();
  f = await seedTwoOrgs();
  await pools.root.query(`update auth."user" set email = 'a-user@example.uz', "emailVerified" = true where id = $1`, [f.aUser.userId]);
});

/** Ждущие письма одному получателю. */
async function queue(count: number): Promise<void> {
  await pools.root.query(
    `insert into hdn_outbox (ticket_id, channel, recipient_kind, recipient_user_id, template, payload, locale, status, attempts, next_attempt_on)
     select $1, 'email', 'user', $2, 'ticket_resolved', $3, 'ru', 'queued', 0, now() - interval '1 minute' - (g || ' milliseconds')::interval
       from generate_series(1, $4::int) g`,
    [f.tickets.aOrg.ticketId, f.aUser.userId, JSON.stringify({ template: 'ticket_resolved', number: f.tickets.aOrg.number, title: 'Отчёт', url: `/tickets/${f.tickets.aOrg.number}` }), count],
  );
}
/** Состояния писем этого теста. В заготовке данных есть своя отправленная строка (набор изоляции), она не считается. */
const statuses = async () =>
  Object.fromEntries(
    (await pools.root.query(`select status, count(*)::int as n from hdn_outbox where template = 'ticket_resolved' group by status`)).rows.map((r) => [r.status, r.n]),
  ) as Record<string, number>;

test('один запуск отправляет всю очередь, а не одну пачку', async () => {
  await queue(500);
  expect(await dispatchOutbox(SYSTEM, new Date(), provider)).toEqual({ sent: 500, failed: 0, skipped: 0 });
  expect(provider.sent).toHaveLength(500);
  expect(new Set(provider.sent.map((item) => item.idempotencyKey)).size).toBe(500);
  expect(await statuses()).toEqual({ sent: 500 });
}, 120_000);

test('получатель и настройки читаются один раз на запуск, а не на каждое письмо', async () => {
  await queue(100);
  const counted = await countTransactions(() => dispatchOutbox(SYSTEM, new Date(), provider));
  expect(counted.result.sent).toBe(100);
  // Захват пачек и по одной отметке на письмо, плюс несколько чтений настроек на весь запуск.
  expect(counted.app).toBeLessThanOrEqual(112);
  // Один получатель на все письма: его адрес читается один раз.
  expect(counted.auth).toBeLessThanOrEqual(2);
}, 120_000);

test('одновременно идёт несколько отправок, но не больше четырёх', async () => {
  await queue(60);
  let running = 0;
  let peak = 0;
  const slow: EmailProvider = {
    ...provider,
    async send(message, key) {
      running += 1;
      peak = Math.max(peak, running);
      await new Promise((done) => setTimeout(done, 5));
      running -= 1;
      return provider.send(message, key);
    },
  };
  expect((await dispatchOutbox(SYSTEM, new Date(), slow)).sent).toBe(60);
  expect(peak).toBeGreaterThan(1);
  expect(peak).toBeLessThanOrEqual(4);
});

test('запуск укладывается в бюджет времени: что не успел, остаётся ждать без потраченной попытки', async () => {
  await queue(300);
  let clock = 1_000_000;
  const timed: EmailProvider = {
    ...provider,
    async send(message, key) {
      clock += 2_000;
      return provider.send(message, key);
    },
  };
  const result = await dispatchOutbox(SYSTEM, new Date(), timed, null, { budgetMs: 20_000, clock: () => clock });
  expect(result.sent).toBeGreaterThanOrEqual(10);
  expect(result.sent).toBeLessThan(60);
  const left = (await pools.root.query(`select count(*)::int as n, max(attempts)::int as attempts, bool_and(next_attempt_on <= now()) as due from hdn_outbox where status = 'queued' and template = 'ticket_resolved'`)).rows[0];
  expect(left.n).toBe(300 - result.sent);
  // Попытка не потрачена и письмо не отложено на срок захвата: следующий запуск возьмёт его сразу.
  expect(left.attempts).toBe(0);
  expect(left.due).toBe(true);
  expect((await dispatchOutbox(SYSTEM, new Date(), provider)).sent).toBe(300 - result.sent);
}, 120_000);

test('сбой отдельных писем не останавливает остальные', async () => {
  await queue(40);
  let calls = 0;
  const flaky: EmailProvider = {
    ...provider,
    async send(message, key) {
      calls += 1;
      if (calls % 4 === 0) throw new Error('сбой сервиса');
      return provider.send(message, key);
    },
  };
  const result = await dispatchOutbox(SYSTEM, new Date(), flaky);
  expect(result).toEqual({ sent: 30, failed: 0, skipped: 0 });
  expect(await statuses()).toEqual({ sent: 30, queued: 10 });
  expect((await pools.root.query(`select min(attempts)::int as a, bool_and(next_attempt_on > now()) as later from hdn_outbox where status = 'queued'`)).rows[0]).toEqual({ a: 1, later: true });
});

test('сбой чтения получателя не запоминается на весь запуск: остальные письма уходят (проверка волны 2)', async () => {
  await queue(3);
  const real = contacts();
  let calls = 0;
  registerContactDirectory({
    ...real,
    mailRecipient: async (userId) => {
      if (++calls === 1) throw new Error('база не ответила');
      return real.mailRecipient(userId);
    },
  });
  try {
    // Раньше отказ запоминался вместе с ожиданием: все письма этому получателю в запуске теряли попытку.
    expect(await dispatchOutbox(SYSTEM, new Date(), provider, null, { concurrency: 1 })).toEqual({ sent: 2, failed: 0, skipped: 0 });
  } finally {
    registerContactDirectory(real);
  }
  expect(await statuses()).toEqual({ sent: 2, queued: 1 });
});

test('остановка процесса прерывает запуск между строками: нетронутые письма не теряют попытку (проверка волны 2)', async () => {
  await queue(120);
  let stopped = false;
  const slow: EmailProvider = {
    ...provider,
    send: async (mail, key) => {
      const sent = await provider.send(mail, key);
      // Сигнал остановки приходит во время отправки первых писем.
      if (provider.sent.length >= 3) stopped = true;
      return sent;
    },
  };
  const result = await dispatchOutbox(SYSTEM, new Date(), slow, null, { concurrency: 1, stopped: () => stopped });
  expect(result.sent).toBe(3);
  // Остальные ждут следующего запуска сразу и с нулём попыток: захват первой пачки снят.
  const rows = (await pools.root.query(`select status, attempts, next_attempt_on <= now() as due from hdn_outbox where template = 'ticket_resolved'`)).rows;
  expect(rows.filter((row) => row.status === 'sent')).toHaveLength(3);
  const waiting = rows.filter((row) => row.status === 'queued');
  expect(waiting).toHaveLength(117);
  expect(waiting.every((row) => row.attempts === 0 && row.due)).toBe(true);
});
