import { createHmac, randomBytes } from 'node:crypto';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import { type AddressInfo, createServer as createTcpServer } from 'node:net';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { runCli } from '@/cli/commands';
import { processEvents } from '@/modules/hdc/api';
import { QUEUES } from '../../scripts/db/pgboss.mjs';
import { handleRuleEvent, newRuleRun } from '@/modules/hdw/api/engine';
import { saveRule, setRuleEnabled } from '@/modules/hdw/api/rules';
import { cleanupWebhookDeliveries, dispatchWebhooks, handleWebhookEvent, hasDueDeliveries, WEBHOOK_MAX_ATTEMPTS, WEBHOOK_RETRY_MINUTES } from '@/modules/hdw/api/webhook-jobs';
import { createWebhook, deleteWebhook, listWebhookDeliveries, listWebhooks, readWebhook, rotateWebhookSecret, sendTestWebhook, updateWebhook } from '@/modules/hdw/api/webhooks';
import { setDnsResolverForTests } from '@/security/outbound';
import { createSecretBox, type SecretBox } from '@/security/secret-box';
import { SCHEDULES } from '@/worker/main';
import { clientCtx, staffCtx, staffWithRole } from './helpers/auth';
import { asActor, pools } from './helpers/db';
import { type Fixture, seedTwoOrgs, type TicketRef } from './isolation/fixture';

// Исходящие вебхуки (ТЗ 7.17, FR-AUTO-10, FR-ADM-11; план M8, задача 5, решения 9-11). Адреса ведёт администратор,
// секрет показывается один раз, доставки ставит и отправляет система. Приёмник в тестах локальный: портал в тестах
// работает на localhost, поэтому сетевой слой допускает http на 127.0.0.1 (как ложный сервер входа).

const SYSTEM = { type: 'system', job: 'webhooks.dispatch' } as const;
const AUTOMATION = { type: 'system', job: 'automation.process' } as const;
const ID = '019a1111-1111-7111-8111-111111111111';
const MINUTE = 60_000;
const shared = globalThis as typeof globalThis & { __hubSecretBox?: SecretBox };
const originalBox = shared.__hubSecretBox;

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
  shared.__hubSecretBox = originalBox;
  for (const close of closers.splice(0)) await close();
});

type Received = { headers: IncomingHttpHeaders; body: string };
/** Ложный приёмник: запоминает заголовки и тело, отвечает заданным кодом. */
async function receiver(status: () => number = () => 200): Promise<{ url: string; port: number; received: Received[] }> {
  const received: Received[] = [];
  const server: Server = createServer((req, res) => {
    let body = '';
    req.on('data', (piece) => (body += String(piece)));
    req.on('end', () => {
      received.push({ headers: req.headers, body });
      res.writeHead(status()).end('тело ответа приёмника не читается');
    });
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  closers.push(() => new Promise((done) => server.close(() => done())));
  const port = (server.address() as AddressInfo).port;
  return { url: `http://127.0.0.1:${port}/hook`, port, received };
}

type DeliveryRow = { delivery_id: string; endpoint_id: string; event_id: string | null; org_id: string | null; ticket_id: string | null; kind: string; body: Record<string, unknown>; status: string; attempts: number; last_error: string | null; next_attempt_on: Date };
const deliveries = (endpointId?: string) =>
  pools.root.query<DeliveryRow>(`select * from hdw_webhook_deliveries ${endpointId ? 'where endpoint_id = $1' : ''} order by delivery_id`, endpointId ? [endpointId] : []).then((r) => r.rows);
const auditOf = (objectId: string) => pools.root.query(`select action, actor_type, actor_id, diff from hdc_audit_log where object_id = $1 order by created_on, audit_id`, [objectId]).then((r) => r.rows);
const emit = (ticket: TicketRef, orgId: string, kind = 'client_replied', byRule = false) =>
  pools.root.query(`insert into hdc_domain_events (org_id, ticket_id, kind, is_by_rule) values ($1, $2, $3, $4) returning event_id`, [orgId, ticket.ticketId, kind, byRule]).then((r) => r.rows[0].event_id as string);
/** Разбор событий, как в фоновом процессе: правила, затем подписки адресов. */
async function drain() {
  const run = newRuleRun();
  return processEvents(AUTOMATION, async (tx, event) => {
    await handleRuleEvent(tx, event, run);
    await handleWebhookEvent(tx, event);
  });
}
const verify = (secret: string, got: Received): { t: number; ok: boolean } => {
  const match = /^t=(\d+),v1=([0-9a-f]{64})$/.exec(String(got.headers['x-hub-signature']));
  if (!match) return { t: 0, ok: false };
  return { t: Number(match[1]), ok: createHmac('sha256', secret).update(`${match[1]}.${got.body}`).digest('hex') === match[2] };
};

test('администратор создаёт адрес: секрет возвращается один раз, в базе он зашифрован, в журнале его нет', async () => {
  const hook = await receiver();
  const created = await createWebhook(admin, { name: 'Учётная система', url: hook.url, events: ['ticket_created', 'status_changed'] });
  expect(created.secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
  const row = (await pools.root.query(`select e.name, e.url, e.events, e.is_enabled, s.sealed from hdw_webhook_endpoints e join hdw_webhook_secrets s using (endpoint_id) where e.endpoint_id = $1`, [created.endpointId])).rows[0];
  expect(row).toMatchObject({ name: 'Учётная система', url: hook.url, events: ['ticket_created', 'status_changed'], is_enabled: true });
  expect(row.sealed).toMatch(/^v1\./);
  expect(row.sealed).not.toContain(created.secret);
  // Больше секрет не отдаёт ни одна точка входа.
  const read = await readWebhook(admin, created.endpointId);
  expect(read).toMatchObject({ endpointId: created.endpointId, name: 'Учётная система', url: hook.url, events: ['ticket_created', 'status_changed'], isEnabled: true });
  expect(JSON.stringify([read, await listWebhooks(admin), await listWebhookDeliveries(admin, { endpointId: created.endpointId })])).not.toContain(created.secret);
  const audit = await auditOf(created.endpointId);
  expect(audit).toMatchObject([{ action: 'webhook.created', actor_type: 'staff', actor_id: f.adminStaff.userId, diff: { name: 'Учётная система', events: ['ticket_created', 'status_changed'] } }]);
  expect(JSON.stringify(audit)).not.toContain(created.secret);
  expect(await readWebhook(admin, 'не идентификатор')).toBeNull();
  expect(await readWebhook(admin, ID)).toBeNull();
});

test('адрес при сохранении: только https, без учётной записи, узел внешний и разрешается во внешние адреса', async () => {
  const good = { name: 'Партнёр', events: [] };
  for (const url of ['http://hooks.partner.example/in', 'https://user:pass@hooks.partner.example/in', 'https://10.0.0.5/in', 'https://[::1]/in', 'https://db.internal/in', 'ftp://hooks.partner.example/in', 'не адрес'])
    await expect(createWebhook(admin, { ...good, url }), url).rejects.toMatchObject({ code: 'invalid_url' });
  setDnsResolverForTests(async () => ['203.0.113.10', '192.168.0.4']);
  await expect(createWebhook(admin, { ...good, url: 'https://hooks.partner.example/in' })).rejects.toMatchObject({ code: 'invalid_url' });
  setDnsResolverForTests(async () => []);
  await expect(createWebhook(admin, { ...good, url: 'https://hooks.partner.example/in' })).rejects.toMatchObject({ code: 'invalid_url' });
  expect((await pools.root.query(`select count(*)::int as n from hdw_webhook_endpoints`)).rows[0].n).toBe(0);
  setDnsResolverForTests(async () => ['203.0.113.10']);
  const { endpointId } = await createWebhook(admin, { ...good, url: 'https://hooks.partner.example/in' });
  // Правка проверяет адрес так же.
  await expect(updateWebhook(admin, { endpointId, name: 'Партнёр', url: 'https://169.254.169.254/latest', events: [], isEnabled: true })).rejects.toMatchObject({ code: 'invalid_url' });
  for (const bad of [{ ...good, url: 'https://hooks.partner.example/in', events: ['no_such_event'] }, { ...good, url: 'https://hooks.partner.example/in', name: '' }, { ...good, url: 'https://hooks.partner.example/in', secret: 'свой' }])
    await expect(createWebhook(admin, bad)).rejects.toMatchObject({ code: 'invalid_input' });
});

test('доставка по подписке: приёмник получает подписанное тело без темы, описания и переписки', async () => {
  const hook = await receiver();
  const { endpointId, secret } = await createWebhook(admin, { name: 'Учёт', url: hook.url, events: ['client_replied'] });
  const t = f.tickets.aOrg;
  const moduleId = (await pools.root.query(`insert into hdr_product_modules (code, name) values ('orders', '{"ru": "Заказы"}') returning module_id`)).rows[0].module_id;
  await pools.root.query(`update hdt_tickets set module_id = $2, queue = 'l2' where ticket_id = $1`, [t.ticketId, moduleId]);
  await pools.root.query(`with tag as (insert into hdr_tags (name) values ('Срочно') returning tag_id) insert into hdt_ticket_tags (org_id, ticket_id, tag_id) select $1, $2, tag_id from tag`, [f.orgA.orgId, t.ticketId]);
  await pools.root.query(`insert into hdt_ticket_messages (org_id, ticket_id, author_id, author_type, body, is_internal) values ($1, $2, $3, 'client', 'Кассовый чек печатается дважды', false)`, [f.orgA.orgId, t.ticketId, f.aUser.userId]);
  const eventId = await emit(t, f.orgA.orgId);
  // Событие другого вида и событие обращения другой организации без подписки доставок не дают.
  await emit(f.tickets.bOrg, f.orgB.orgId, 'rated');
  expect(await drain()).toMatchObject({ processed: 2, failed: 0 });
  const [queued, ...rest] = await deliveries(endpointId);
  expect(rest).toEqual([]);
  expect(queued).toMatchObject({ event_id: eventId, org_id: f.orgA.orgId, ticket_id: t.ticketId, kind: 'client_replied', status: 'queued', attempts: 0, last_error: null });
  expect(await hasDueDeliveries(SYSTEM)).toBe(true);

  const before = Math.floor(Date.now() / 1000);
  expect(await dispatchWebhooks(SYSTEM)).toEqual({ sent: 1, failed: 0, retried: 0, cancelled: 0 });
  expect(await hasDueDeliveries(SYSTEM)).toBe(false);
  expect(hook.received).toHaveLength(1);
  const got = hook.received[0] as Received;
  expect(got.headers['content-type']).toBe('application/json');
  expect(got.headers['x-hub-event']).toBe('client_replied');
  expect(got.headers['x-hub-delivery']).toBe(queued?.delivery_id);
  // Приёмник проверяет подпись секретом, который администратор видел при создании.
  const signature = verify(secret, got);
  expect(signature.ok).toBe(true);
  expect(signature.t).toBeGreaterThanOrEqual(before);
  expect(signature.t).toBeLessThanOrEqual(Math.floor(Date.now() / 1000) + 1);
  expect(verify('чужой секрет', got).ok).toBe(false);
  const body = JSON.parse(got.body);
  expect(body).toEqual({
    event: 'client_replied',
    occurredOn: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
    ticket: { number: t.number, ticketId: t.ticketId, orgId: f.orgA.orgId, status: 'new', priority: 'p2', type: 'bug', queue: 'l2', moduleCode: 'orders', tags: ['Срочно'] },
  });
  // Решение 11: ни темы, ни описания, ни слов переписки, ни имён и адресов людей.
  const row = (await pools.root.query(`select title, description from hdt_tickets where ticket_id = $1`, [t.ticketId])).rows[0];
  const texts = (await pools.root.query(`select body from hdt_ticket_messages where ticket_id = $1`, [t.ticketId])).rows.map((m) => m.body as string);
  const people = (await pools.root.query(`select name, email from auth."user"`)).rows.flatMap((u) => [u.name as string, u.email as string]);
  const words = [row.title, row.description, ...texts].flatMap((text: string) => text.split(/[\s:,.]+/)).filter((word) => word.length >= 4);
  expect(words.length).toBeGreaterThan(5);
  for (const word of [...words, ...people, 'ACME']) expect(got.body.toLowerCase(), word).not.toContain(word.toLowerCase());
  expect((await deliveries(endpointId))[0]).toMatchObject({ status: 'sent', attempts: 1, last_error: null });
  // Повторный запуск ничего не отправляет.
  expect(await dispatchWebhooks(SYSTEM)).toEqual({ sent: 0, failed: 0, retried: 0, cancelled: 0 });
  expect(hook.received).toHaveLength(1);
});

test('действие правила "вызвать вебхук" ставит доставку в транзакции правила; событие уходит на адрес один раз', async () => {
  const hook = await receiver();
  const byRuleOnly = await createWebhook(admin, { name: 'Только правило', url: hook.url, events: [] });
  const both = await createWebhook(admin, { name: 'Правило и подписка', url: hook.url, events: ['client_replied', 'priority_changed'] });
  const off = await createWebhook(admin, { name: 'Выключен', url: hook.url, events: ['client_replied'], isEnabled: false });
  // Несуществующий адрес правило сохранить не даёт.
  await expect(saveRule(admin, { name: 'Вебхук', event: 'client_replied', conditions: { match: 'all', items: [] }, actions: [{ action: 'webhook', endpointId: ID }] })).rejects.toMatchObject({
    code: 'invalid_input',
    issues: [{ path: 'actions.0.endpointId', code: 'reference_missing' }],
  });
  const { ruleId } = await saveRule(admin, {
    name: 'Вебхук',
    event: 'client_replied',
    conditions: { match: 'all', items: [] },
    actions: [{ action: 'set_priority', priority: 'p1' }, { action: 'webhook', endpointId: byRuleOnly.endpointId }, { action: 'webhook', endpointId: both.endpointId }, { action: 'webhook', endpointId: off.endpointId }],
  });
  await setRuleEnabled(admin, { ruleId, enabled: true });
  const t = f.tickets.aOrg;
  const eventId = await emit(t, f.orgA.orgId);
  // Событие клиента и событие смены приоритета от правила: оно порождено правилом, но это тоже факт об обращении.
  expect(await drain()).toMatchObject({ processed: 2, failed: 0 });
  const run = (await pools.root.query(`select result, actions_done from hdw_rule_runs where rule_id = $1`, [ruleId])).rows[0];
  expect(run).toMatchObject({
    result: 'partial',
    actions_done: [
      { action: 'set_priority', ok: true },
      { action: 'webhook', ok: true, to: 'Только правило' },
      { action: 'webhook', ok: true, to: 'Правило и подписка' },
      { action: 'webhook', ok: false, detail: 'endpoint_disabled' },
    ],
  });
  expect((await deliveries(byRuleOnly.endpointId)).map((d) => [d.kind, d.event_id])).toEqual([['client_replied', eventId]]);
  // Подписанный адрес вызван и правилом, и подпиской: одна доставка на событие, тело несёт состояние после правил.
  const subscribed = await deliveries(both.endpointId);
  expect(subscribed.map((d) => d.kind)).toEqual(['client_replied', 'priority_changed']);
  expect(subscribed[0]).toMatchObject({ event_id: eventId, body: { event: 'client_replied', ticket: { priority: 'p1' } } });
  expect(await deliveries(off.endpointId)).toEqual([]);
  expect(await dispatchWebhooks(SYSTEM)).toMatchObject({ sent: 3, failed: 0 });
  expect(hook.received.map((got) => got.headers['x-hub-event']).sort()).toEqual(['client_replied', 'client_replied', 'priority_changed']);

  // Откат срабатывания правила уносит и доставку: сбой следующего действия откатывает только его, вебхук остаётся.
  await pools.root.query(`delete from hdw_webhook_deliveries`);
  await deleteWebhook(admin, { endpointId: byRuleOnly.endpointId });
  await emit(t, f.orgA.orgId);
  await drain();
  // Адрес удалён после сохранения правила: действие записано отказом, остальные выполняются.
  const last = (await pools.root.query(`select actions_done from hdw_rule_runs where rule_id = $1 order by run_id desc limit 1`, [ruleId])).rows[0];
  expect(last.actions_done[1]).toEqual({ action: 'webhook', ok: false, detail: 'endpoint_missing' });
  expect(last.actions_done[2]).toMatchObject({ action: 'webhook', ok: true });
});

test('повторы после неудачи через 1, 5, 15, 60 и 240 минут, затем failed: не больше пяти повторов', async () => {
  let code = 503;
  const hook = await receiver(() => code);
  const { endpointId } = await createWebhook(admin, { name: 'Сбоит', url: hook.url, events: ['client_replied'] });
  await emit(f.tickets.aOrg, f.orgA.orgId);
  await drain();
  let now = new Date();
  expect(WEBHOOK_RETRY_MINUTES).toEqual([1, 5, 15, 60, 240]);
  expect(WEBHOOK_MAX_ATTEMPTS).toBe(6);
  const ids = new Set<string>();
  for (const [index, pause] of WEBHOOK_RETRY_MINUTES.entries()) {
    expect(await dispatchWebhooks(SYSTEM, { now }), `попытка ${index + 1}`).toEqual({ sent: 0, failed: 0, retried: 1, cancelled: 0 });
    const [row] = await deliveries(endpointId);
    expect(row).toMatchObject({ status: 'queued', attempts: index + 1, last_error: 'http_503' });
    expect(row?.next_attempt_on.getTime()).toBe(now.getTime() + pause * MINUTE);
    // Раньше срока повтор не уходит.
    expect(await dispatchWebhooks(SYSTEM, { now: new Date(now.getTime() + pause * MINUTE - 1000) })).toMatchObject({ retried: 0, sent: 0 });
    now = new Date(now.getTime() + pause * MINUTE);
  }
  // Шестая неудача: доставка получает failed и больше не отправляется.
  expect(await dispatchWebhooks(SYSTEM, { now })).toEqual({ sent: 0, failed: 1, retried: 0, cancelled: 0 });
  expect((await deliveries(endpointId))[0]).toMatchObject({ status: 'failed', attempts: 6, last_error: 'http_503' });
  expect(await dispatchWebhooks(SYSTEM, { now: new Date(now.getTime() + 1000 * MINUTE) })).toEqual({ sent: 0, failed: 0, retried: 0, cancelled: 0 });
  expect(hook.received).toHaveLength(6);
  // Идентификатор доставки один на все повторы: приёмник отличает повтор от нового события.
  for (const got of hook.received) ids.add(String(got.headers['x-hub-delivery']));
  expect(ids.size).toBe(1);
  // Тело ответа приёмника в журнал не попадает.
  expect(JSON.stringify(await deliveries())).not.toContain('тело ответа');

  // Приёмник ожил между повторами: доставка уходит и получает sent.
  await pools.root.query(`delete from hdw_webhook_deliveries`);
  await emit(f.tickets.aOrg, f.orgA.orgId);
  await drain();
  expect(await dispatchWebhooks(SYSTEM, { now })).toMatchObject({ retried: 1 });
  code = 204;
  expect(await dispatchWebhooks(SYSTEM, { now: new Date(now.getTime() + MINUTE) })).toMatchObject({ sent: 1 });
  expect((await deliveries(endpointId))[0]).toMatchObject({ status: 'sent', attempts: 2, last_error: null });
});

test('переадресация и внутренний адрес при соединении: запрос не идёт дальше, доставка записана неудачей с кодом', async () => {
  // Приёмник отвечает переадресацией на внутренний узел: по новому адресу никто не идёт.
  let targetHits = 0;
  const target = createServer((_req, res) => {
    targetHits += 1;
    res.writeHead(200).end();
  });
  await new Promise<void>((done) => target.listen(0, '127.0.0.1', done));
  closers.push(() => new Promise((done) => target.close(() => done())));
  const redirecting = createServer((_req, res) => res.writeHead(307, { location: `http://127.0.0.1:${(target.address() as AddressInfo).port}/` }).end());
  await new Promise<void>((done) => redirecting.listen(0, '127.0.0.1', done));
  closers.push(() => new Promise((done) => redirecting.close(() => done())));
  const redirect = await createWebhook(admin, { name: 'Переадресация', url: `http://127.0.0.1:${(redirecting.address() as AddressInfo).port}/hook`, events: ['client_replied'] });

  // Имя при сохранении вело на внешний адрес, при соединении ведёт во внутреннюю сеть (подмена DNS).
  let connections = 0;
  const inner = createTcpServer((socket) => {
    connections += 1;
    socket.destroy();
  });
  await new Promise<void>((done) => inner.listen(0, '127.0.0.1', done));
  closers.push(() => new Promise((done) => inner.close(() => done())));
  const rebind = await createWebhook(admin, { name: 'Подмена', url: `https://rebind.partner.example:${(inner.address() as AddressInfo).port}/hook`, events: ['client_replied'] });
  setDnsResolverForTests(async () => ['127.0.0.1']);

  await emit(f.tickets.aOrg, f.orgA.orgId);
  await drain();
  expect(await dispatchWebhooks(SYSTEM)).toMatchObject({ sent: 0, retried: 2 });
  expect((await deliveries(redirect.endpointId))[0]).toMatchObject({ status: 'queued', attempts: 1, last_error: 'http_307' });
  expect((await deliveries(rebind.endpointId))[0]).toMatchObject({ status: 'queued', attempts: 1, last_error: 'blocked_address' });
  expect(targetHits).toBe(0);
  expect(connections).toBe(0);
});

test('приёмник молчит: запрос обрывается по времени, доставка ждёт повтора', async () => {
  const silent = createServer(() => {});
  await new Promise<void>((done) => silent.listen(0, '127.0.0.1', done));
  closers.push(
    () =>
      new Promise((done) => {
        silent.closeAllConnections();
        silent.close(() => done());
      }),
  );
  const { endpointId } = await createWebhook(admin, { name: 'Молчит', url: `http://127.0.0.1:${(silent.address() as AddressInfo).port}/hook`, events: ['client_replied'] });
  await emit(f.tickets.aOrg, f.orgA.orgId);
  await drain();
  expect(await dispatchWebhooks(SYSTEM, { timeoutMs: 200 })).toMatchObject({ retried: 1 });
  expect((await deliveries(endpointId))[0]).toMatchObject({ status: 'queued', attempts: 1, last_error: 'timeout' });
});

test('выключение и удаление адреса отменяют его ждущие доставки', async () => {
  const hook = await receiver();
  const a = await createWebhook(admin, { name: 'А', url: hook.url, events: ['client_replied'] });
  const b = await createWebhook(admin, { name: 'Б', url: hook.url, events: ['client_replied'] });
  const c = await createWebhook(admin, { name: 'В', url: hook.url, events: ['client_replied'] });
  await emit(f.tickets.aOrg, f.orgA.orgId);
  await drain();
  expect(await deliveries()).toHaveLength(3);
  // Выключение через точку входа отменяет ждущие сразу.
  await updateWebhook(admin, { endpointId: a.endpointId, name: 'А', url: hook.url, events: ['client_replied'], isEnabled: false });
  expect((await deliveries(a.endpointId))[0]).toMatchObject({ status: 'failed', attempts: 0, last_error: 'endpoint_disabled' });
  // Адрес выключили в обход точки входа: отправка сама не шлёт на выключенный адрес.
  await pools.root.query(`update hdw_webhook_endpoints set is_enabled = false where endpoint_id = $1`, [b.endpointId]);
  await deleteWebhook(admin, { endpointId: c.endpointId });
  expect(await deliveries(c.endpointId)).toEqual([]);
  expect(await dispatchWebhooks(SYSTEM)).toEqual({ sent: 0, failed: 0, retried: 0, cancelled: 1 });
  expect((await deliveries(b.endpointId))[0]).toMatchObject({ status: 'failed', attempts: 0, last_error: 'endpoint_disabled' });
  expect(hook.received).toEqual([]);
  // На выключенный адрес новые доставки не ставятся, проверочная отправка отказывает.
  await emit(f.tickets.aOrg, f.orgA.orgId);
  await drain();
  expect(await deliveries()).toHaveLength(2);
  await expect(sendTestWebhook(admin, { endpointId: a.endpointId })).rejects.toMatchObject({ code: 'endpoint_disabled' });
  expect((await auditOf(c.endpointId)).map((x) => x.action)).toEqual(['webhook.created', 'webhook.deleted']);
  expect((await auditOf(a.endpointId)).map((x) => x.action)).toEqual(['webhook.created', 'webhook.updated']);
});

test('отправка останавливается вместе с процессом; два процесса не шлют одну доставку дважды', async () => {
  const hook = await receiver();
  await createWebhook(admin, { name: 'А', url: hook.url, events: ['client_replied', 'rated'] });
  for (const kind of ['client_replied', 'rated', 'client_replied']) await emit(f.tickets.aOrg, f.orgA.orgId, kind);
  await drain();
  expect(await deliveries()).toHaveLength(3);
  // Процесс останавливается после первой доставки: остальные возвращаются в очередь без потраченной попытки.
  const stopped = await dispatchWebhooks(SYSTEM, { concurrency: 1, stopped: () => hook.received.length >= 1 });
  expect(stopped).toMatchObject({ sent: 1 });
  expect((await deliveries()).map((d) => [d.status, d.attempts]).sort()).toEqual([['queued', 0], ['queued', 0], ['sent', 1]]);
  // Два процесса одновременно: каждая доставка уходит один раз.
  const [x, y] = await Promise.all([dispatchWebhooks(SYSTEM), dispatchWebhooks(SYSTEM)]);
  expect((x?.sent ?? 0) + (y?.sent ?? 0)).toBe(2);
  expect(hook.received).toHaveLength(3);
  expect(new Set(hook.received.map((got) => got.headers['x-hub-delivery'])).size).toBe(3);
});

test('смена секрета: новый показывается один раз, подпись идёт новым секретом; проверочная отправка без данных обращений', async () => {
  const hook = await receiver();
  const { endpointId, secret } = await createWebhook(admin, { name: 'А', url: hook.url, events: [] });
  const rotated = await rotateWebhookSecret(admin, { endpointId });
  expect(rotated.secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(rotated.secret).not.toBe(secret);
  const { deliveryId } = await sendTestWebhook(admin, { endpointId });
  const [row] = await deliveries(endpointId);
  expect(row).toMatchObject({ delivery_id: deliveryId, kind: 'test', event_id: null, org_id: null, ticket_id: null, status: 'queued' });
  expect(await dispatchWebhooks(SYSTEM)).toMatchObject({ sent: 1 });
  const got = hook.received[0] as Received;
  expect(got.headers['x-hub-event']).toBe('test');
  expect(verify(rotated.secret, got).ok).toBe(true);
  expect(verify(secret, got).ok).toBe(false);
  // Образец тела той же формы, идентификаторы нулевые: настоящих обращений в нём нет.
  const body = JSON.parse(got.body);
  expect(body).toMatchObject({ event: 'test', ticket: { number: 0, ticketId: '00000000-0000-0000-0000-000000000000', orgId: '00000000-0000-0000-0000-000000000000', tags: [] } });
  expect(Object.keys(body.ticket).sort()).toEqual(['moduleCode', 'number', 'orgId', 'priority', 'queue', 'status', 'tags', 'ticketId', 'type']);
  const audit = await auditOf(endpointId);
  expect(audit.map((x) => x.action)).toEqual(['webhook.created', 'webhook.secret_rotated', 'webhook.test_sent']);
  // Секрет и доставку пишет система после проверки администратора: он назван в записи.
  expect(audit[1]).toMatchObject({ actor_type: 'system', diff: { by: f.adminStaff.userId } });
  expect(JSON.stringify(audit)).not.toContain(rotated.secret);
  // Журнал доставок: новые сверху, с номером обращения, без секрета.
  await pools.root.query(`update hdw_webhook_endpoints set events = '{client_replied}' where endpoint_id = $1`, [endpointId]);
  await emit(f.tickets.aOrg, f.orgA.orgId);
  await drain();
  const log = await listWebhookDeliveries(admin, { endpointId });
  expect(log.items.map((item) => [item.kind, item.ticketNumber, item.status, item.attempts])).toEqual([['client_replied', f.tickets.aOrg.number, 'queued', 0], ['test', null, 'sent', 1]]);
  expect(log.nextCursor).toBeNull();
  await expect(listWebhookDeliveries(admin, { endpointId: ID })).rejects.toMatchObject({ code: 'not_found' });
});

test('адреса и доставки видит и меняет только администратор со свежим входом; клиент не видит ничего', async () => {
  const hook = await receiver();
  const { endpointId } = await createWebhook(admin, { name: 'А', url: hook.url, events: ['client_replied'] });
  await sendTestWebhook(admin, { endpointId });
  const input = { name: 'Б', url: hook.url, events: [] };
  const stale = { ...admin, sessionCreatedAt: new Date(Date.now() - 901e3) };
  const writes: [string, (ctx: typeof admin) => Promise<unknown>][] = [
    ['создание', (ctx) => createWebhook(ctx, input)],
    ['правка', (ctx) => updateWebhook(ctx, { endpointId, ...input, isEnabled: true })],
    ['смена секрета', (ctx) => rotateWebhookSecret(ctx, { endpointId })],
    ['проверочная отправка', (ctx) => sendTestWebhook(ctx, { endpointId })],
    ['удаление', (ctx) => deleteWebhook(ctx, { endpointId })],
  ];
  for (const [name, call] of writes) await expect(call(stale), name).rejects.toMatchObject({ code: 'stale_session' });
  // Читать со старой сессией можно: меняет только свежая.
  expect(await listWebhooks(stale)).toHaveLength(1);
  for (const role of ['agent_l1', 'agent_l2', 'care', 'product'] as const) {
    const member = await staffWithRole(role);
    const ctx = staffCtx(member);
    for (const [name, call] of writes) await expect(call(ctx), `${role}: ${name}`).rejects.toMatchObject({ code: 'forbidden' });
    await expect(listWebhooks(ctx), role).rejects.toMatchObject({ code: 'forbidden' });
    await expect(readWebhook(ctx, endpointId), role).rejects.toMatchObject({ code: 'forbidden' });
    await expect(listWebhookDeliveries(ctx, { endpointId }), role).rejects.toMatchObject({ code: 'forbidden' });
    // Политики базы: сотрудник без роли администратора не читает ни адресов, ни доставок, ни секретов.
    for (const table of ['hdw_webhook_endpoints', 'hdw_webhook_deliveries', 'hdw_webhook_secrets'])
      expect((await asActor(pools.app, member.actor, (c) => c.query(`select 1 from ${table}`))).rows, `${role}: ${table}`).toEqual([]);
    await expect(asActor(pools.app, member.actor, (c) => c.query(`insert into hdw_webhook_endpoints (name, url) values ('Чужой', 'https://evil.example/in')`))).rejects.toThrow(/row-level security/);
    expect((await asActor(pools.app, member.actor, (c) => c.query(`update hdw_webhook_endpoints set url = 'https://evil.example/in'`))).rowCount).toBe(0);
    expect((await asActor(pools.app, member.actor, (c) => c.query(`delete from hdw_webhook_endpoints`))).rowCount).toBe(0);
  }
  // Администратор: секрет не читает и не меняет, доставки сам не пишет.
  const adminActor = f.adminStaff.actor;
  expect((await asActor(pools.app, adminActor, (c) => c.query(`select 1 from hdw_webhook_secrets`))).rows).toEqual([]);
  expect((await asActor(pools.app, adminActor, (c) => c.query(`update hdw_webhook_secrets set sealed = 'v1.a.b.c'`))).rowCount).toBe(0);
  await expect(asActor(pools.app, adminActor, (c) => c.query(`insert into hdw_webhook_deliveries (endpoint_id, kind, body) values ($1, 'test', '{}')`, [endpointId]))).rejects.toThrow(/row-level security/);
  expect((await asActor(pools.app, adminActor, (c) => c.query(`update hdw_webhook_deliveries set status = 'sent'`))).rowCount).toBe(0);
  expect((await asActor(pools.app, adminActor, (c) => c.query(`delete from hdw_webhook_deliveries`))).rowCount).toBe(0);
  // Система адреса не создаёт и не меняет.
  await expect(asActor(pools.app, SYSTEM, (c) => c.query(`insert into hdw_webhook_endpoints (name, url) values ('Система', 'https://evil.example/in')`))).rejects.toThrow(/row-level security/);
  expect((await asActor(pools.app, SYSTEM, (c) => c.query(`update hdw_webhook_endpoints set url = 'https://evil.example/in'`))).rowCount).toBe(0);
  // Клиент: ни строк, ни точек входа.
  for (const member of [f.aUser, f.aAdmin]) {
    for (const table of ['hdw_webhook_endpoints', 'hdw_webhook_deliveries', 'hdw_webhook_secrets'])
      expect((await asActor(pools.app, member.actor, (c) => c.query(`select 1 from ${table}`))).rows, table).toEqual([]);
    await expect(asActor(pools.app, member.actor, (c) => c.query(`insert into hdw_webhook_endpoints (name, url) values ('Клиент', 'https://evil.example/in')`))).rejects.toThrow(/row-level security/);
  }
  const client = await clientCtx(f.aUser);
  await expect(listWebhooks(client as never)).rejects.toMatchObject({ code: 'forbidden' });
  await expect(createWebhook(client as never, input)).rejects.toMatchObject({ code: 'forbidden' });
});

test('ночная очистка удаляет доставки старше 30 суток; задача webhooks.dispatch зарегистрирована', async () => {
  const hook = await receiver();
  const { endpointId } = await createWebhook(admin, { name: 'А', url: hook.url, events: [] });
  await sendTestWebhook(admin, { endpointId });
  await sendTestWebhook(admin, { endpointId });
  const [old] = await deliveries(endpointId);
  await pools.root.query(`alter table hdw_webhook_deliveries disable trigger t_hdw_webhook_deliveries_stamp`);
  await pools.root.query(`update hdw_webhook_deliveries set created_on = now() - interval '31 days' where delivery_id = $1`, [old?.delivery_id]);
  await pools.root.query(`alter table hdw_webhook_deliveries enable trigger t_hdw_webhook_deliveries_stamp`);
  expect(await cleanupWebhookDeliveries(SYSTEM)).toBe(1);
  expect(await deliveries(endpointId)).toHaveLength(1);
  expect(QUEUES).toHaveProperty('webhooks.dispatch');
  expect(SCHEDULES).toContainEqual({ name: 'webhooks.dispatch', cron: '* * * * *', tz: 'UTC' });
});

test('hub secrets:reseal перешифровывает секреты вебхуков: после неё прежний ключ не нужен', async () => {
  const oldKey = randomBytes(32);
  const newKey = randomBytes(32);
  shared.__hubSecretBox = createSecretBox(oldKey);
  const hook = await receiver();
  const { endpointId, secret } = await createWebhook(admin, { name: 'А', url: hook.url, events: [] });
  const broken = await createWebhook(admin, { name: 'Чужой ключ', url: hook.url, events: [] });
  const before = (await pools.root.query(`select sealed from hdw_webhook_secrets where endpoint_id = $1`, [endpointId])).rows[0].sealed as string;
  const lines: string[] = [];
  const errors: string[] = [];
  const io = { env: process.env, out: (line: string) => void lines.push(line), err: (line: string) => void errors.push(line), readSecret: async () => '' };

  // Секрет второго адреса зашифрован третьим ключом: он не открывается, команда его называет и не трогает.
  const lost = createSecretBox(randomBytes(32)).seal('потерянный', `hdw_webhook_secrets:${broken.endpointId}`);
  await pools.root.query(`update hdw_webhook_secrets set sealed = $2 where endpoint_id = $1`, [broken.endpointId, lost]);
  shared.__hubSecretBox = createSecretBox(newKey, [oldKey]);
  expect(await runCli(['secrets:reseal'], io)).toBe(1);
  expect(lines.join('\n')).toContain('секреты вебхуков 1');
  expect(errors.join('\n')).toContain('вебхук Чужой ключ');
  expect(lines.join('\n') + errors.join('\n')).not.toContain(secret);
  const after = (await pools.root.query(`select sealed from hdw_webhook_secrets where endpoint_id = $1`, [endpointId])).rows[0].sealed as string;
  expect(after).not.toBe(before);
  expect((await pools.root.query(`select sealed from hdw_webhook_secrets where endpoint_id = $1`, [broken.endpointId])).rows[0].sealed).toBe(lost);
  expect((await pools.root.query(`select actor_type, diff from hdc_audit_log where action = 'secrets.resealed' and object_type = 'webhook_secret'`)).rows).toEqual([{ actor_type: 'system', diff: { resealed: 1, failed: 1 } }]);

  // Прежний ключ убран: подпись идёт тем же секретом, который видел администратор.
  shared.__hubSecretBox = createSecretBox(newKey);
  await deleteWebhook(admin, { endpointId: broken.endpointId });
  await sendTestWebhook(admin, { endpointId });
  expect(await dispatchWebhooks(SYSTEM)).toMatchObject({ sent: 1 });
  expect(verify(secret, hook.received[0] as Received).ok).toBe(true);
  // Секрет не открывается (ключ сменили без перешифрования): доставка ждёт повтора с кодом, запрос не уходит.
  shared.__hubSecretBox = createSecretBox(randomBytes(32));
  await sendTestWebhook(admin, { endpointId });
  expect(await dispatchWebhooks(SYSTEM)).toMatchObject({ sent: 0, retried: 1 });
  expect((await deliveries(endpointId)).at(-1)).toMatchObject({ status: 'queued', last_error: 'secret_unreadable' });
  expect(hook.received).toHaveLength(1);
});
