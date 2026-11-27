import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { setLogSinkForTests } from '@/lib/log';
import { JOB_NAMES } from '@/modules/hdc/api';
import { postStaffMessage, setStatus, takeTicket } from '@/modules/hdt/api';
import { syncDevTasks } from '@/modules/hdw/api/dev-task-jobs';
import { devTrackerMode, readDevTaskForTicket, sendToDevelopment, setDevTaskStatus } from '@/modules/hdw/api/dev-tasks';
import { handleTrackerWebhook } from '@/modules/hdw/api/tracker-webhook';
import { getDevTracker, setDevTrackerForTests } from '@/modules/hdw/dev-tracker';
import { SCHEDULES } from '@/worker/main';
import { QUEUES } from '../../scripts/db/pgboss.mjs';
import { signTrackerWebhook, startMockTracker } from '../../scripts/mock-tracker.mjs';
import { staffCtx, staffWithRole } from './helpers/auth';
import { pools } from './helpers/db';
import { type Fixture, seedTwoOrgs, type TicketRef } from './isolation/fixture';

// Контрактные тесты заготовки под API таск-менеджера Smartup (ТЗ 7.9, FR-DEV-03, 04, 05; план M8, задача 8,
// решение 13). Настоящего описания API нет: реализация и эти тесты идут против ложного сервера
// scripts/mock-tracker.mjs по предполагаемому договору (docs/integrations/dev-tracker.md). Ложный сервер поднят в
// процессе теста на свободном порту; портал в тестах работает на localhost, поэтому сетевой слой допускает http на
// 127.0.0.1. Вебхук ложного сервера приходит на маленький сервер теста, который передаёт запрос обработчику портала.

const SYSTEM = { type: 'system', job: 'devtasks.sync' } as const;
const TOKEN = 'contract-tracker-token-0123456789abcdef';
const SECRET = 'contract-tracker-webhook-secret-0123456789abcdef';
const MINUTE = 60_000;

let f: Fixture;
let l2: ReturnType<typeof staffCtx>;
let mock: ReturnType<typeof startMockTracker>;
let portal: Server;
let hookUrl: string;
let logs: { level: string; event: string; fields?: Record<string, unknown> }[];

beforeEach(async () => {
  f = await seedTwoOrgs();
  l2 = staffCtx(await staffWithRole('agent_l2'));
  mock = startMockTracker({ port: 0, token: TOKEN, secret: SECRET });
  await mock.ready();
  // Адрес портала для вебхука: запрос ложного сервера уходит обработчику как есть, с телом и заголовками.
  portal = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const headers = new Headers();
      for (const [name, value] of Object.entries(req.headers)) if (typeof value === 'string') headers.set(name, value);
      void handleTrackerWebhook(new Request('http://localhost:3000/api/webhooks/tracker', { method: req.method, headers, body: Buffer.concat(chunks) })).then(async (response) => {
        res.writeHead(response.status);
        res.end(await response.text());
      });
    });
  });
  await new Promise<void>((resolve) => portal.listen(0, '127.0.0.1', () => resolve()));
  hookUrl = `http://127.0.0.1:${(portal.address() as AddressInfo).port}/api/webhooks/tracker`;
  mock.control.webhookUrl = hookUrl;
  setDevTrackerForTests({ settings: { mode: 'smartup', url: mock.baseUrl(), token: TOKEN, webhookSecret: SECRET } });
  logs = [];
  setLogSinkForTests((level, event, fields) => void logs.push({ level, event, fields }));
  await pools.root.query(`delete from hdc_rate_limits where code like 'tracker-webhook:ip:%'`);
});
afterEach(async () => {
  setLogSinkForTests(null);
  setDevTrackerForTests(null);
  await mock.close();
  await new Promise<void>((resolve) => {
    portal.closeAllConnections();
    portal.close(() => resolve());
  });
});

const ticketRow = (ticketId: string) => pools.root.query(`select status, assignee_id from hdt_tickets where ticket_id = $1`, [ticketId]).then((r) => r.rows[0]);
const tasks = () => pools.root.query(`select dev_task_id, tracker, external_id, url, title, status, version, synced_on, closed_notified_on from hdw_dev_tasks order by created_on, dev_task_id`).then((r) => r.rows);
const links = () => pools.root.query(`select ticket_id from hdw_dev_task_links`).then((r) => r.rows.map((row) => row.ticket_id as string));
const history = (ticketId: string) =>
  pools.root.query(`select actor_type, payload from hdt_ticket_events where ticket_id = $1 and kind = 'dev_task' order by created_on, event_id`, [ticketId]).then((r) => r.rows);
const notices = (userId: string) => pools.root.query(`select ticket_id from hdn_notifications where user_id = $1 and kind = 'dev_task_closed'`, [userId]).then((r) => r.rows);
const logged = (event: string) => logs.filter((entry) => entry.event === event).map((entry) => entry.fields);

/** Обращение "В работе" у второй линии, с модулем продукта. */
async function inProgress(t: TicketRef): Promise<void> {
  await takeTicket(l2, t.number);
}
/** Передать обращение в разработку через API и вернуть номер задачи в таск-менеджере. */
async function handOver(t: TicketRef): Promise<string> {
  await inProgress(t);
  await sendToDevelopment(l2, { ticketNumber: t.number });
  return (await readDevTaskForTicket(l2, t.number))?.task.externalId as string;
}
const post = (body: string, headers: Record<string, string>, method = 'POST') =>
  handleTrackerWebhook(new Request('http://localhost:3000/api/webhooks/tracker', { method, headers: { 'content-type': 'application/json', ...headers }, ...(method === 'POST' ? { body } : {}) }));
const signed = (body: string, at = Math.floor(Date.now() / 1000), secret = SECRET) => ({ 'x-tracker-timestamp': String(at), 'x-tracker-signature': signTrackerWebhook(secret, at, body) });
const event = (ref: string, status: string, extra: Record<string, unknown> = {}) => JSON.stringify({ event: 'task.status_changed', ref, status, ...extra });

test('создание задачи: заголовок, описание со ссылкой на обращение, тип, приоритет, модуль и адрес обращения; в ответ номер и ссылка', async () => {
  const t = f.tickets.aOrg;
  const moduleId = (await pools.root.query(`insert into hdr_product_modules (name, code) values ('{"ru": "Склад"}', $1) returning module_id`, [`wms-${Date.now()}`])).rows[0].module_id as string;
  const code = (await pools.root.query(`select code from hdr_product_modules where module_id = $1`, [moduleId])).rows[0].code as string;
  await pools.root.query(`update hdt_tickets set module_id = $2 where ticket_id = $1`, [t.ticketId, moduleId]);
  expect(devTrackerMode()).toBe('smartup');
  await inProgress(t);
  await sendToDevelopment(l2, { ticketNumber: t.number });

  const sourceUrl = `http://localhost:3000/ru/agent/tickets/SUP-${t.number}`;
  expect(mock.created).toHaveLength(1);
  expect(mock.created[0]?.body).toEqual({
    title: t.title,
    descriptionMd: `${t.title}: подробное описание\n\n---\nSmartup Hub: ${sourceUrl}`,
    kind: 'bug',
    priority: 'p2',
    moduleCode: code,
    sourceUrl,
  });
  // Переписка, заметки и вложения в таск-менеджер не уходят.
  const sent = JSON.stringify(mock.created[0]?.body);
  for (const text of ['Публичное сообщение', 'Внутренняя заметка', 'screenshot.png']) expect(sent).not.toContain(text);

  const ref = mock.created[0]?.ref as string;
  const [row] = await tasks();
  expect(row).toMatchObject({ tracker: 'smartup', external_id: ref, url: `${mock.baseUrl()}/tasks/${ref}`, title: t.title, status: 'todo', version: null });
  expect(row.synced_on).not.toBeNull();
  expect((await ticketRow(t.ticketId)).status).toBe('in_development');
  expect(await history(t.ticketId)).toEqual([{ actor_type: 'staff', payload: { action: 'linked', devTaskId: row.dev_task_id, ref } }]);
  expect((await pools.root.query(`select diff from hdc_audit_log where object_id = $1 and action = 'devtask.linked'`, [t.ticketId])).rows).toEqual([
    { diff: { devTaskId: row.dev_task_id, tracker: 'smartup', ref, created: true } },
  ]);
  // Задачу из API сотрудник руками не меняет: её статус приходит из таск-менеджера.
  await expect(setDevTaskStatus(l2, { devTaskId: row.dev_task_id, status: 'done' })).rejects.toMatchObject({ code: 'not_manual' });
  // Номер, ссылка и название из формы ручного режима в режиме API не принимаются.
  await expect(sendToDevelopment(l2, { ticketNumber: f.tickets.aMine.number, externalId: 'X-1', url: 'https://t.example/1', title: 'Название' })).rejects.toMatchObject({ code: 'invalid_input' });
});

test('тип задачи: ошибка это bug, остальное feature; без модуля поле модуля не уходит', async () => {
  const t = f.tickets.aOrg;
  await pools.root.query(`update hdt_tickets set type = 'question', priority = 'p4' where ticket_id = $1`, [t.ticketId]);
  await handOver(t);
  expect(mock.created[0]?.body).toMatchObject({ kind: 'feature', priority: 'p4' });
  expect(mock.created[0]?.body).not.toHaveProperty('moduleCode');
});

test('привязка к существующей задаче по номеру: задача не создаётся, статус берётся из таск-менеджера; неизвестный номер отклоняется', async () => {
  const a = f.tickets.aOrg;
  const b = f.tickets.bOrg;
  mock.add({ ref: 'DEV-77', url: 'https://tasks.smartup.example/tasks/DEV-77', status: 'doing', version: '5.13.0' });
  await inProgress(a);
  await inProgress(b);
  await sendToDevelopment(l2, { ticketNumber: a.number, externalId: 'dev-77' });
  expect(mock.created).toEqual([]);
  expect((await tasks())[0]).toMatchObject({ tracker: 'smartup', external_id: 'DEV-77', url: 'https://tasks.smartup.example/tasks/DEV-77', title: '', status: 'in_progress', version: '5.13.0' });
  // Вторая привязка к той же задаче в таск-менеджер уже не ходит: задача известна порталу.
  mock.control.fail = true;
  await sendToDevelopment(l2, { ticketNumber: b.number, externalId: 'DEV-77' });
  mock.control.fail = false;
  expect(await tasks()).toHaveLength(1);
  expect((await readDevTaskForTicket(l2, a.number))?.otherTickets).toEqual([b.number]);

  const c = f.tickets.aMine;
  await inProgress(c);
  await expect(sendToDevelopment(l2, { ticketNumber: c.number, externalId: 'DEV-404' })).rejects.toMatchObject({ code: 'task_not_found' });
  mock.add({ ref: 'DEV-78', url: 'https://tasks.smartup.example/tasks/DEV-78', status: 'released' });
  await expect(sendToDevelopment(l2, { ticketNumber: c.number, externalId: 'DEV-78' })).rejects.toMatchObject({ code: 'task_closed' });
  expect((await ticketRow(c.ticketId)).status).toBe('in_progress');
  expect(await tasks()).toHaveLength(1);
});

test('смена статуса вебхуком: подпись ложного сервера принимается, задача закрыта, исполнителю одно напоминание, статус обращения прежний', async () => {
  const t = f.tickets.aOrg;
  const ref = await handOver(t);
  mock.setStatus(ref, 'in_progress');
  expect((await mock.sendWebhook(ref)).status).toBe(200);
  expect((await tasks())[0]).toMatchObject({ status: 'in_progress', closed_notified_on: null });
  expect(await notices(l2.user.id)).toEqual([]);

  mock.setStatus(ref, 'done', '5.14.2');
  const sent = await mock.sendWebhook(ref);
  expect(sent.status).toBe(200);
  const [row] = await tasks();
  expect(row).toMatchObject({ status: 'done', version: '5.14.2' });
  expect(row.closed_notified_on).not.toBeNull();
  expect((await ticketRow(t.ticketId)).status).toBe('in_development');
  expect(await notices(l2.user.id)).toEqual([{ ticket_id: t.ticketId }]);
  expect((await history(t.ticketId)).at(-1)).toEqual({ actor_type: 'system', payload: { action: 'closed', ref, status: 'done', version: '5.14.2' } });
  expect((await pools.root.query(`select actor_type, diff from hdc_audit_log where object_id = $1 and action = 'devtask.status_changed' order by created_on, audit_id`, [row.dev_task_id])).rows).toEqual([
    { actor_type: 'system', diff: { from: 'todo', to: 'in_progress' } },
    { actor_type: 'system', diff: { from: 'in_progress', to: 'done', version: '5.14.2' } },
  ]);

  // Повтор того же события (то же тело, то же время, та же подпись) ничего не меняет.
  expect((await post(sent.body, signed(sent.body, sent.timestamp))).status).toBe(200);
  expect((await mock.sendWebhook(ref)).status).toBe(200);
  expect(await notices(l2.user.id)).toHaveLength(1);
  expect((await history(t.ticketId)).filter((e) => e.payload.action === 'closed')).toHaveLength(1);
  expect((await pools.root.query(`select count(*)::int as n from hdc_audit_log where object_id = $1 and action = 'devtask.status_changed'`, [row.dev_task_id])).rows[0].n).toBe(2);
});

test('вебхук: неверная подпись и устаревшее время отклоняются, задача не меняется', async () => {
  const ref = await handOver(f.tickets.aOrg);
  mock.setStatus(ref, 'done');
  // Чужой секрет.
  expect((await mock.sendWebhook(ref, { secret: 'другой секрет подписи, не короче тридцати двух' })).status).toBe(401);
  // Время старше и новее пяти минут: подпись верна, запрос не принимается. Запас 10 секунд: обработчик берёт своё время
  // позже теста, и переход секунды между ними делал +301 равным 300 (принят). Ровно 300 и 301 проверяет
  // tests/unit/hdw/tracker-sign.test.ts на заданном времени.
  const now = Math.floor(Date.now() / 1000);
  expect((await mock.sendWebhook(ref, { timestamp: now - 310 })).status).toBe(401);
  expect((await mock.sendWebhook(ref, { timestamp: now + 310 })).status).toBe(401);
  const body = event(ref, 'done');
  // Подпись от другого тела, подпись без времени в расчёте, нет заголовков.
  expect((await post(body, signed(event(ref, 'todo')))).status).toBe(401);
  expect((await post(body, { 'x-tracker-timestamp': String(now), 'x-tracker-signature': signTrackerWebhook(SECRET, now - 1, body) })).status).toBe(401);
  expect((await post(body, {})).status).toBe(401);
  expect((await post(body, { 'x-tracker-signature': signTrackerWebhook(SECRET, now, body) })).status).toBe(401);
  expect((await tasks())[0]).toMatchObject({ status: 'todo', closed_notified_on: null });
  expect(logged('devtask.webhook_refused').map((x) => x?.reason)).toEqual(['bad_signature', 'stale', 'stale', 'bad_signature', 'bad_signature', 'missing', 'missing']);
  // Граница окна принимается.
  expect((await mock.sendWebhook(ref, { timestamp: now - 290 })).status).toBe(200);
  expect((await tasks())[0].status).toBe('done');
});

test('вебхук: неизвестная задача и незнакомый статус отвечают 200 и ничего не меняют; тело проверяется после подписи', async () => {
  const ref = await handOver(f.tickets.aOrg);
  // Неизвестный номер: тот же ответ, что и для известного (существование задач не раскрывается).
  const unknown = event('DEV-404', 'done');
  expect((await post(unknown, signed(unknown))).status).toBe(200);
  // Задача ручного режима с тем же номером вебхуком не меняется.
  await pools.root.query(`insert into hdw_dev_tasks (tracker, external_id, url, title) values ('manual', 'MAN-1', 'https://t.example/1', 'Ручная')`);
  const manual = event('MAN-1', 'done');
  expect((await post(manual, signed(manual))).status).toBe(200);
  expect((await tasks()).find((row) => row.external_id === 'MAN-1')?.status).toBe('todo');
  // Незнакомый статус: без изменений, запись в журнале событий.
  const blocked = event(ref, 'blocked');
  expect((await post(blocked, signed(blocked))).status).toBe(200);
  expect((await tasks())[0].status).toBe('todo');
  expect(logged('devtask.unknown_status')).toEqual([{ ref, status: 'blocked' }]);
  // Другое событие таск-менеджера порталу не интересно.
  const other = JSON.stringify({ event: 'task.commented', ref, status: 'done' });
  expect((await post(other, signed(other))).status).toBe(200);
  expect((await tasks())[0].status).toBe('todo');

  for (const [name, body, status] of [
    ['не JSON', '{не json', 400],
    ['нет номера', JSON.stringify({ event: 'task.status_changed', status: 'done' }), 400],
    ['номер с пробелом', event('DEV 1', 'done'), 400],
    ['не объект', '[]', 400],
  ] as const)
    expect((await post(body, signed(body))).status, name).toBe(status);
  // Тело больше 16 КБ не читается.
  const big = event(ref, 'done', { pad: 'x'.repeat(17_000) });
  expect((await post(big, signed(big))).status).toBe(413);
  expect((await post('', {}, 'GET')).status).toBe(405);
  expect((await tasks())[0].status).toBe('todo');
});

test('вебхук в ручном режиме не существует: 404', async () => {
  setDevTrackerForTests(null);
  expect(devTrackerMode()).toBe('manual');
  const body = event('DEV-1', 'done');
  expect((await post(body, signed(body))).status).toBe(404);
});

test('вебхук: больше 600 запросов в минуту с одного адреса получают 429', async () => {
  const body = event('DEV-404', 'done');
  const headers = { ...signed(body), 'x-forwarded-for': '203.0.113.77' };
  for (let i = 0; i < 3; i++) expect((await post(body, headers)).status).toBe(200);
  await pools.root.query(`update hdc_rate_limits set hits = 600 where code like 'tracker-webhook:ip:%'`);
  const refused = await post(body, headers);
  expect(refused.status).toBe(429);
  expect(Number(refused.headers.get('retry-after'))).toBeGreaterThan(0);
});

test('смена статуса опросом: открытые задачи, не сверенные 15 минут; закрытие напоминает один раз', async () => {
  const t = f.tickets.aOrg;
  const ref = await handOver(t);
  mock.setStatus(ref, 'done', '5.15.0');
  // Задача сверена только что (при создании): раньше чем через 15 минут опрос к ней не идёт.
  expect(await syncDevTasks(SYSTEM)).toEqual({ checked: 0, updated: 0, failed: 0, reminded: 0 });
  expect((await tasks())[0].status).toBe('todo');

  const later = new Date(Date.now() + 16 * MINUTE);
  expect(await syncDevTasks(SYSTEM, { now: later })).toEqual({ checked: 1, updated: 1, failed: 0, reminded: 1 });
  expect((await tasks())[0]).toMatchObject({ status: 'done', version: '5.15.0' });
  expect((await ticketRow(t.ticketId)).status).toBe('in_development');
  expect(await notices(l2.user.id)).toEqual([{ ticket_id: t.ticketId }]);
  expect((await history(t.ticketId)).at(-1)).toEqual({ actor_type: 'system', payload: { action: 'closed', ref, status: 'done', version: '5.15.0' } });
  // Закрытая задача больше не опрашивается.
  expect(await syncDevTasks(SYSTEM, { now: new Date(later.getTime() + 60 * MINUTE) })).toEqual({ checked: 0, updated: 0, failed: 0, reminded: 0 });
  expect(await notices(l2.user.id)).toHaveLength(1);
});

test('опрос: незнакомый статус и пропавшая задача ничего не меняют, сбой одной задачи не мешает остальным', async () => {
  const first = await handOver(f.tickets.aOrg);
  const second = await handOver(f.tickets.bOrg);
  const third = await handOver(f.tickets.aMine);
  mock.setStatus(first, 'blocked');
  mock.tasks.delete(second.toLowerCase());
  mock.setStatus(third, 'review');
  const later = new Date(Date.now() + 16 * MINUTE);
  expect(await syncDevTasks(SYSTEM, { now: later })).toEqual({ checked: 3, updated: 1, failed: 0, reminded: 0 });
  const rows = await tasks();
  expect(rows.map((row) => [row.external_id, row.status])).toEqual([[first, 'todo'], [second, 'todo'], [third, 'in_progress']]);
  expect(logged('devtask.unknown_status')).toEqual([{ ref: first, status: 'blocked' }]);
  expect(logged('devtask.missing')).toEqual([{ ref: second }]);
  // Все три отмечены сверенными: следующий запуск через минуту к ним не возвращается.
  expect(await syncDevTasks(SYSTEM, { now: new Date(later.getTime() + MINUTE) })).toEqual({ checked: 0, updated: 0, failed: 0, reminded: 0 });

  // Таск-менеджер недоступен: запуск не падает, задачи остаются на следующий раз.
  mock.control.fail = true;
  const next = new Date(later.getTime() + 16 * MINUTE);
  expect(await syncDevTasks(SYSTEM, { now: next })).toEqual({ checked: 3, updated: 0, failed: 3, reminded: 0 });
  expect(logged('devtask.tracker_failed')).toHaveLength(3);
  mock.control.fail = false;
  mock.setStatus(first, 'done');
  expect(await syncDevTasks(SYSTEM, { now: next })).toMatchObject({ checked: 3, updated: 1, failed: 0 });
  expect((await tasks()).map((row) => row.status)).toEqual(['done', 'todo', 'in_progress']);
});

test('опрос в ручном режиме ничего не делает; задание зарегистрировано раз в 15 минут', async () => {
  const ref = await handOver(f.tickets.aOrg);
  mock.setStatus(ref, 'done');
  setDevTrackerForTests(null);
  expect(await syncDevTasks(SYSTEM, { now: new Date(Date.now() + 16 * MINUTE) })).toEqual({ checked: 0, updated: 0, failed: 0, reminded: 0 });
  expect((await tasks())[0].status).toBe('todo');
  expect(SCHEDULES).toContainEqual({ name: 'devtasks.sync', cron: '*/15 * * * *', tz: 'UTC' });
  expect(JOB_NAMES).toContain('devtasks.sync');
  expect(QUEUES).toHaveProperty('devtasks.sync');
});

test('таск-менеджер недоступен: передача отказывает, обращение не меняется, остальная работа с обращением идёт; повтор проходит', async () => {
  const t = f.tickets.aOrg;
  await inProgress(t);
  mock.control.fail = true;
  await expect(sendToDevelopment(l2, { ticketNumber: t.number })).rejects.toMatchObject({ code: 'tracker_unavailable' });
  await expect(sendToDevelopment(l2, { ticketNumber: t.number, externalId: 'DEV-77' })).rejects.toMatchObject({ code: 'tracker_unavailable' });
  expect(await tasks()).toEqual([]);
  expect(await links()).toEqual([]);
  expect(await history(t.ticketId)).toEqual([]);
  expect((await ticketRow(t.ticketId)).status).toBe('in_progress');
  expect(logged('devtask.tracker_failed')).toEqual([{ op: 'create', error: 'http_503' }, { op: 'get', error: 'http_503' }]);
  // Обращение ведётся как обычно: ответ клиенту и смена статуса.
  expect((await postStaffMessage(l2, { number: t.number, body: 'Проверяем, вернёмся с ответом.', internal: false, seenVersion: new Date(Date.now() + MINUTE).toISOString() })).ok).toBe(true);
  await setStatus(l2, { number: t.number, to: 'waiting_customer' });
  await setStatus(l2, { number: t.number, to: 'in_progress' });
  // Таск-менеджер вернулся: сотрудник повторяет действие.
  mock.control.fail = false;
  await sendToDevelopment(l2, { ticketNumber: t.number });
  expect((await ticketRow(t.ticketId)).status).toBe('in_development');
  expect(await tasks()).toHaveLength(1);
});

test('таск-менеджер отвечает дольше срока или чужим токеном: тот же чистый отказ', async () => {
  const t = f.tickets.aOrg;
  await inProgress(t);
  mock.control.delayMs = 600;
  setDevTrackerForTests({ settings: { mode: 'smartup', url: mock.baseUrl(), token: TOKEN, webhookSecret: SECRET, timeoutMs: 150 } });
  await expect(sendToDevelopment(l2, { ticketNumber: t.number })).rejects.toMatchObject({ code: 'tracker_unavailable' });
  mock.control.delayMs = 0;
  setDevTrackerForTests({ settings: { mode: 'smartup', url: mock.baseUrl(), token: 'someone-elses-token-0123456789abcdef', webhookSecret: SECRET } });
  await expect(sendToDevelopment(l2, { ticketNumber: t.number })).rejects.toMatchObject({ code: 'tracker_unavailable' });
  expect(logged('devtask.tracker_failed').map((x) => x?.error)).toEqual(['timeout', 'http_401']);
  expect(await tasks()).toEqual([]);
  expect((await ticketRow(t.ticketId)).status).toBe('in_progress');
  // Токен в журнал событий не попадает.
  expect(JSON.stringify(logs)).not.toContain(TOKEN);
});

test('до обращения к таск-менеджеру проверяются роль, статус и привязка: лишняя задача не создаётся', async () => {
  const t = f.tickets.aOrg;
  // "Новое": перехода нет.
  await expect(sendToDevelopment(l2, { ticketNumber: t.number })).rejects.toMatchObject({ code: 'transition_refused' });
  await expect(sendToDevelopment(staffCtx(f.l1), { ticketNumber: t.number })).rejects.toMatchObject({ code: 'forbidden' });
  await expect(sendToDevelopment(l2, { ticketNumber: 999_999_999 })).rejects.toMatchObject({ code: 'not_found' });
  await handOver(t);
  await expect(sendToDevelopment(l2, { ticketNumber: t.number })).rejects.toMatchObject({ code: 'already_linked' });
  expect(mock.created).toHaveLength(1);
});

test('задача создана, а привязка не прошла: номер осиротевшей задачи записан в журнал событий, обращение не изменено', async () => {
  const t = f.tickets.aOrg;
  await inProgress(t);
  // Между созданием задачи и транзакцией привязки обращение решили: переход "В разработке" уже невозможен.
  const real = getDevTracker();
  setDevTrackerForTests({
    settings: { mode: 'smartup', url: mock.baseUrl(), token: TOKEN, webhookSecret: SECRET },
    tracker: {
      getTask: (ref) => real.getTask(ref),
      async createTask(input) {
        const created = await real.createTask(input);
        await pools.root.query(`update hdt_tickets set status = 'resolved', resolution_type = 'solved', resolved_on = now() where ticket_id = $1`, [t.ticketId]);
        return created;
      },
    },
  });
  await expect(sendToDevelopment(l2, { ticketNumber: t.number })).rejects.toMatchObject({ code: 'transition_refused' });
  const ref = mock.created[0]?.ref;
  expect(logged('devtask.orphan')).toEqual([{ ref, ticketNumber: t.number }]);
  expect(await tasks()).toEqual([]);
  expect(await links()).toEqual([]);
  expect((await ticketRow(t.ticketId)).status).toBe('resolved');
});
