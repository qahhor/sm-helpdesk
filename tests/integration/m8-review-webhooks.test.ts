import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { processEvents } from '@/modules/hdc/api';
import { addTicketTag, isHdtError } from '@/modules/hdt/api';
import { handleRuleEvent, newRuleRun } from '@/modules/hdw/api/engine';
import { saveRule, setRuleEnabled } from '@/modules/hdw/api/rules';
import { dispatchWebhooks, handleWebhookEvent } from '@/modules/hdw/api/webhook-jobs';
import { createWebhook } from '@/modules/hdw/api/webhooks';
import { setDnsResolverForTests } from '@/security/outbound';
import { staffCtx } from './helpers/auth';
import { asActor, pools } from './helpers/db';
import { type Fixture, seedTwoOrgs, type TicketRef } from './isolation/fixture';

// Исправления по независимой проверке вехи M8: исходящие вебхуки и теги (находки S2, I6).

const SYSTEM = { type: 'system', job: 'webhooks.dispatch' } as const;
const AUTOMATION = { type: 'system', job: 'automation.process' } as const;
let f: Fixture;
let admin: ReturnType<typeof staffCtx>;
const closers: Array<() => Promise<void>> = [];

beforeEach(async () => {
  f = await seedTwoOrgs();
  admin = staffCtx(f.adminStaff);
  setDnsResolverForTests(async () => ['203.0.113.10']);
});
afterEach(async () => {
  setDnsResolverForTests(null);
  for (const close of closers.splice(0)) await close();
});

const emit = (ticket: TicketRef, orgId: string, kind = 'client_replied') =>
  pools.root.query(`insert into hdc_domain_events (org_id, ticket_id, kind) values ($1, $2, $3) returning event_id`, [orgId, ticket.ticketId, kind]).then((r) => r.rows[0].event_id as string);
/** Разбор событий, как в фоновом процессе: правила, затем подписки адресов. */
async function drain() {
  const run = newRuleRun();
  return processEvents(AUTOMATION, async (tx, event) => {
    await handleRuleEvent(tx, event, run);
    await handleWebhookEvent(tx, event);
  });
}
const deliveries = (endpointId: string) =>
  pools.root
    .query<{ delivery_id: string; body: { ticket: { tags: string[]; tagsTruncated?: boolean } }; status: string; attempts: number; last_error: string | null; bytes: number }>(
      `select delivery_id, body, status, attempts, last_error, octet_length(body::text) as bytes from hdw_webhook_deliveries where endpoint_id = $1 order by delivery_id`,
      [endpointId],
    )
    .then((r) => r.rows);
async function noteRule(): Promise<string> {
  const { ruleId } = await saveRule(admin, { name: 'Заметка на ответ', event: 'client_replied', conditions: { match: 'all', items: [] }, actions: [{ action: 'add_note', text: 'Клиент ответил' }], isStop: false });
  await setRuleEnabled(admin, { ruleId, enabled: true });
  return ruleId;
}
const runCount = async (ruleId: string) => (await pools.root.query(`select count(*)::int as n from hdw_rule_runs where rule_id = $1 and result = 'applied'`, [ruleId])).rows[0].n as number;
/** Теги на обращении строками, как их оставила прежняя версия: предела на число тегов тогда не было. */
async function legacyTags(ticket: TicketRef, orgId: string, count: number): Promise<void> {
  const client = await pools.root.connect();
  try {
    // Триггер предела числа тегов на время вставки отключён: так выглядят данные, записанные до его появления.
    await client.query(`set session_replication_role = replica`);
    for (let i = 0; i < count; i++) {
      const name = `${String(i).padStart(3, '0')} ${'Ж'.repeat(36)}`;
      await client.query(`with tag as (insert into hdr_tags (name) values ($3) returning tag_id) insert into hdt_ticket_tags (org_id, ticket_id, tag_id) select $1, $2, tag_id from tag`, [orgId, ticket.ticketId, name]);
    }
  } finally {
    await client.query(`set session_replication_role = origin`);
    client.release();
  }
}

// --- S2: постановка вебхука не откатывает разбор события ---

test('S2: обращение с сотней длинных тегов: событие разобрано, правило сработало, в теле доставки список тегов обрезан с отметкой', async () => {
  const t = f.tickets.aOrg;
  await legacyTags(t, f.orgA.orgId, 100);
  const { endpointId } = await createWebhook(admin, { name: 'Учёт', url: 'https://hooks.partner.example/in', events: ['client_replied'] });
  const ruleId = await noteRule();
  await emit(t, f.orgA.orgId);
  expect(await drain()).toEqual({ processed: 1, failed: 0 });
  expect(await runCount(ruleId)).toBe(1);
  const [queued, ...rest] = await deliveries(endpointId);
  expect(rest).toEqual([]);
  expect(queued?.bytes).toBeLessThanOrEqual(8000);
  // В теле первые по алфавиту теги, не больше предела на обращение, и отметка, что список неполный.
  expect(queued?.body.ticket.tags).toHaveLength(20);
  expect(queued?.body.ticket.tags[0]).toMatch(/^000 /);
  expect(queued?.body.ticket.tagsTruncated).toBe(true);
  // Обращение с обычным числом тегов: отметки нет.
  await pools.root.query(`with tag as (insert into hdr_tags (name) values ('Срочно') returning tag_id) insert into hdt_ticket_tags (org_id, ticket_id, tag_id) select $1, $2, tag_id from tag`, [f.orgB.orgId, f.tickets.bOrg.ticketId]);
  await emit(f.tickets.bOrg, f.orgB.orgId);
  await drain();
  const other = (await deliveries(endpointId)).at(-1);
  expect(other?.body.ticket.tags).toEqual(['Срочно']);
  expect(other?.body.ticket).not.toHaveProperty('tagsTruncated');
});

test('S2: сбой постановки доставки по подписке откатывает только её: событие разобрано, правило сработало', async () => {
  const t = f.tickets.aOrg;
  const { endpointId } = await createWebhook(admin, { name: 'Учёт', url: 'https://hooks.partner.example/in', events: ['client_replied'] });
  const ruleId = await noteRule();
  // База отказывает во вставке доставки этого вида: ограничение на время теста.
  await pools.owner.query(`alter table hdw_webhook_deliveries add constraint hdw_webhook_deliveries_test_fail check (kind <> 'client_replied') not valid`);
  try {
    await emit(t, f.orgA.orgId);
    expect(await drain()).toEqual({ processed: 1, failed: 0 });
  } finally {
    await pools.owner.query(`alter table hdw_webhook_deliveries drop constraint hdw_webhook_deliveries_test_fail`);
  }
  expect(await runCount(ruleId)).toBe(1);
  expect(await deliveries(endpointId)).toEqual([]);
  expect((await pools.root.query(`select attempts, processed_on is not null as processed from hdc_domain_events where ticket_id = $1`, [t.ticketId])).rows).toEqual([{ attempts: 0, processed: true }]);
});

test('S2: на обращении не больше 20 тегов: сотрудник получает понятный отказ, правило записывает отказ, база не принимает двадцать первый', async () => {
  const t = f.tickets.aOrg;
  const l1 = staffCtx(f.l1);
  for (let i = 1; i <= 20; i++) await addTicketTag(l1, { number: t.number, name: `Тег ${i}` });
  // Тег, который уже стоит, отказа не даёт: менять нечего.
  await expect(addTicketTag(l1, { number: t.number, name: 'Тег 7' })).resolves.toBeUndefined();
  const refused = await addTicketTag(l1, { number: t.number, name: 'Лишний' }).catch((error: unknown) => error);
  expect(isHdtError(refused) && refused.code).toBe('too_many_tags');
  expect((await pools.root.query(`select count(*)::int as n from hdt_ticket_tags where ticket_id = $1`, [t.ticketId])).rows[0].n).toBe(20);
  // Правило с действием "добавить тег": отказ с кодом, остальные действия выполняются.
  const tagId = (await pools.root.query(`insert into hdr_tags (name) values ('От правила') returning tag_id`)).rows[0].tag_id as string;
  const { ruleId } = await saveRule(admin, { name: 'Тег и заметка', event: 'client_replied', conditions: { match: 'all', items: [] }, actions: [{ action: 'add_tag', tagId }, { action: 'add_note', text: 'Клиент ответил' }], isStop: false });
  await setRuleEnabled(admin, { ruleId, enabled: true });
  await emit(t, f.orgA.orgId);
  expect(await drain()).toEqual({ processed: 1, failed: 0 });
  expect((await pools.root.query(`select result, actions_done from hdw_rule_runs where rule_id = $1`, [ruleId])).rows).toMatchObject([
    { result: 'partial', actions_done: [{ action: 'add_tag', ok: false, detail: 'too_many_tags' }, { action: 'add_note', ok: true }] },
  ]);
  // Прямая вставка в базу под сотрудником и под системой: триггер не принимает двадцать первый тег.
  for (const actor of [f.l1.actor, AUTOMATION])
    await expect(
      asActor(pools.app, actor, (c) => c.query(`insert into hdt_ticket_tags (org_id, ticket_id, tag_id, added_by) values ($1, $2, $3, $4)`, [f.orgA.orgId, t.ticketId, tagId, actor.type === 'staff' ? actor.userId : null])),
    ).rejects.toMatchObject({ code: '23514' });
  // На другом обращении место есть.
  await expect(addTicketTag(l1, { number: f.tickets.bOrg.number, name: 'Лишний' })).resolves.toBeUndefined();
});

// --- I6: молчащий адрес с очередью не задерживает исправные ---

/** Приёмник, который отвечает 200 и считает запросы. */
async function healthy(): Promise<{ url: string; hits: () => number }> {
  let hits = 0;
  const server: Server = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      hits++;
      res.writeHead(200).end();
    });
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  closers.push(() => new Promise((done) => server.close(() => done())));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/hook`, hits: () => hits };
}
/** Приёмник, который принимает соединение и молчит. */
async function blackhole(): Promise<string> {
  const server = createServer(() => {});
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  closers.push(
    () =>
      new Promise((done) => {
        server.closeAllConnections();
        server.close(() => done());
      }),
  );
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}/hook`;
}

test('I6: адрес с большой очередью, который не отвечает, не задерживает доставки исправному адресу', async () => {
  const dead = await createWebhook(admin, { name: 'Молчит', url: await blackhole(), events: [] });
  const good = await healthy();
  const live = await createWebhook(admin, { name: 'Работает', url: good.url, events: [] });
  // У молчащего адреса 60 давних доставок: вся первая пачка отправки раньше состояла из них.
  await pools.root.query(
    `insert into hdw_webhook_deliveries (org_id, endpoint_id, ticket_id, kind, body, next_attempt_on)
     select $1, $2, $3, 'client_replied', '{"event": "client_replied"}', now() - interval '2 hours' + make_interval(secs => n) from generate_series(1, 60) n`,
    [f.orgA.orgId, dead.endpointId, f.tickets.aOrg.ticketId],
  );
  await pools.root.query(
    `insert into hdw_webhook_deliveries (org_id, endpoint_id, ticket_id, kind, body, next_attempt_on)
     select $1, $2, $3, 'client_replied', '{"event": "client_replied"}', now() - make_interval(secs => 30 - n) from generate_series(1, 12) n`,
    [f.orgA.orgId, live.endpointId, f.tickets.aOrg.ticketId],
  );
  // Бюджет запуска короткий: молчащий адрес держит каждый запрос до срока ожидания ответа.
  const started = Date.now();
  const result = await dispatchWebhooks(SYSTEM, { timeoutMs: 300, budgetMs: 4000 });
  expect(Date.now() - started).toBeLessThan(15_000);
  // Все доставки исправного адреса ушли в этом же запуске.
  expect(good.hits()).toBe(12);
  expect(result.sent).toBe(12);
  expect((await deliveries(live.endpointId)).every((row) => row.status === 'sent')).toBe(true);
  // Молчащий адрес за запуск получил не больше одной пачки своих доставок; остальные ждут без потраченной попытки.
  const waiting = await deliveries(dead.endpointId);
  expect(waiting.filter((row) => row.attempts > 0).length).toBeLessThanOrEqual(5);
  expect(waiting.filter((row) => row.attempts > 0).length).toBeGreaterThan(0);
  expect(waiting.every((row) => row.status === 'queued')).toBe(true);
});
