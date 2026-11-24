import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { setLogSinkForTests } from '@/lib/log';
import { createSmartupTracker, DevTrackerUnavailableError, DevTrackerUnknownStatusError } from '@/modules/hdw/dev-tracker/smartup';

// Реализация DevTracker для API таск-менеджера Smartup (FR-DEV-03, 04; план M8, задача 8). Договор предполагаемый
// (docs/integrations/dev-tracker.md). Здесь проверяется то, что от договора не зависит: запросы идут через
// защищённый сетевой слой (только https, внутренние адреса закрыты, переадресации не выполняются, срок ответа),
// ответ не по договору это отказ, а не данные, токен и текст ответа не попадают в журнал.

const TOKEN = 'unit-tracker-token-0123456789';
const closers: Array<() => Promise<void>> = [];
let logs: { event: string; fields?: Record<string, unknown> }[];

beforeEach(() => {
  logs = [];
  setLogSinkForTests((_level, event, fields) => void logs.push({ event, fields }));
});
afterEach(async () => {
  setLogSinkForTests(null);
  for (const close of closers.splice(0)) await close();
});

type Seen = { method?: string; url?: string; auth?: string; body: string };

async function server(handler: (req: IncomingMessage, res: ServerResponse, body: string) => void): Promise<{ base: string; seen: Seen[] }> {
  const seen: Seen[] = [];
  const srv: Server = createServer((req, res) => {
    let body = '';
    req.on('data', (piece) => (body += String(piece)));
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, auth: req.headers.authorization, body });
      handler(req, res, body);
    });
  });
  await new Promise<void>((done) => srv.listen(0, '127.0.0.1', done));
  closers.push(
    () =>
      new Promise((done) => {
        srv.closeAllConnections();
        srv.close(() => done());
      }),
  );
  return { base: `http://127.0.0.1:${(srv.address() as AddressInfo).port}`, seen };
}
const json = (res: ServerResponse, status: number, body: unknown) => res.writeHead(status, { 'content-type': 'application/json' }).end(typeof body === 'string' ? body : JSON.stringify(body));
const tracker = (base: string, extra: { allowLoopback?: boolean; timeoutMs?: number } = {}) => createSmartupTracker({ baseUrl: base, token: TOKEN, allowLoopback: extra.allowLoopback ?? true, ...(extra.timeoutMs ? { timeoutMs: extra.timeoutMs } : {}) });
const input = { title: 'Не проводится накладная', descriptionMd: 'Описание', kind: 'bug' as const, priority: 'p1', moduleCode: 'wms', sourceUrl: 'https://hub.example.test/ru/agent/tickets/SUP-1047' };
const failure = (code: string) => expect.objectContaining({ name: 'DevTrackerUnavailableError', code });

test('создание задачи: POST /tasks с токеном Bearer и всеми полями; в ответ номер и ссылка', async () => {
  const srv = await server((_req, res) => json(res, 201, { ref: 'DEV-1204', url: 'https://tasks.smartup.example/tasks/DEV-1204', extra: 'поле сверх договора не мешает' }));
  expect(await tracker(`${srv.base}/api/v1/`).createTask(input)).toEqual({ ref: 'DEV-1204', url: 'https://tasks.smartup.example/tasks/DEV-1204' });
  expect(srv.seen).toEqual([{ method: 'POST', url: '/api/v1/tasks', auth: `Bearer ${TOKEN}`, body: JSON.stringify(input) }]);
  // Необязательные поля, которых нет, в запрос не попадают.
  await tracker(srv.base).createTask({ title: 'Задача', descriptionMd: 'Текст', kind: 'feature', sourceUrl: input.sourceUrl });
  expect(JSON.parse(srv.seen[1]?.body ?? '{}')).toEqual({ title: 'Задача', descriptionMd: 'Текст', kind: 'feature', sourceUrl: input.sourceUrl });
});

test('чтение задачи: статус переводится в статус портала, 404 это "нет задачи", номер кодируется в адресе', async () => {
  const srv = await server((req, res) => {
    if (req.url === '/tasks/DEV-404') return json(res, 404, { error: 'not_found' });
    return json(res, 200, { ref: 'DEV-1204', url: 'https://tasks.smartup.example/tasks/DEV-1204', status: req.url === '/tasks/DEV-2' ? 'Released' : 'review', version: req.url === '/tasks/DEV-2' ? ' 5.14.2 ' : null });
  });
  const t = tracker(srv.base);
  expect(await t.getTask('DEV-1')).toEqual({ ref: 'DEV-1204', url: 'https://tasks.smartup.example/tasks/DEV-1204', status: 'in_progress' });
  expect(await t.getTask('DEV-2')).toEqual({ ref: 'DEV-1204', url: 'https://tasks.smartup.example/tasks/DEV-1204', status: 'done', version: '5.14.2' });
  expect(await t.getTask('DEV-404')).toBeNull();
  await t.getTask('A/B ?#');
  expect(srv.seen.map((x) => [x.method, x.url, x.auth])).toEqual([
    ['GET', '/tasks/DEV-1', `Bearer ${TOKEN}`],
    ['GET', '/tasks/DEV-2', `Bearer ${TOKEN}`],
    ['GET', '/tasks/DEV-404', `Bearer ${TOKEN}`],
    ['GET', '/tasks/A%2FB%20%3F%23', `Bearer ${TOKEN}`],
  ]);
});

test('незнакомый статус: особая ошибка, статус попадает в журнал', async () => {
  const srv = await server((_req, res) => json(res, 200, { ref: 'DEV-1', url: 'https://tasks.smartup.example/tasks/DEV-1', status: 'blocked' }));
  await expect(tracker(srv.base).getTask('DEV-1')).rejects.toBeInstanceOf(DevTrackerUnknownStatusError);
  expect(logs).toEqual([{ event: 'devtask.unknown_status', fields: { ref: 'DEV-1', status: 'blocked' } }]);
});

test('переадресации не выполняются: ни при создании, ни при чтении; по новому адресу токен не уходит', async () => {
  const target = await server((_req, res) => json(res, 200, { ref: 'EVIL-1', url: 'https://evil.example/1', status: 'done' }));
  const srv = await server((_req, res) => res.writeHead(307, { location: `${target.base}/tasks` }).end());
  await expect(tracker(srv.base).createTask(input)).rejects.toEqual(failure('http_307'));
  await expect(tracker(srv.base).getTask('DEV-1')).rejects.toEqual(failure('http_307'));
  expect(target.seen).toEqual([]);
});

test('только https и только внешние адреса: http, внутренний адрес и подмена DNS отклоняются до соединения', async () => {
  const srv = await server((_req, res) => json(res, 200, { ref: 'DEV-1', url: 'https://t.example/1', status: 'done' }));
  // Портал не на localhost: локальный адрес таск-менеджера закрыт, как и любой http.
  for (const base of [srv.base, 'http://tasks.smartup.example', 'https://10.0.0.5', 'https://127.0.0.1:1', 'https://169.254.169.254', 'https://[::1]', `https://user:pass@127.0.0.1:1`]) {
    await expect(tracker(base, { allowLoopback: false }).createTask(input), base).rejects.toEqual(failure('blocked_address'));
    await expect(tracker(base, { allowLoopback: false }).getTask('DEV-1'), base).rejects.toEqual(failure('blocked_address'));
  }
  // Даже рядом с локальным порталом http на внешний узел не идёт.
  await expect(tracker('http://tasks.smartup.example').createTask(input)).rejects.toEqual(failure('blocked_address'));
  expect(srv.seen).toEqual([]);
});

test('ответ не по договору это отказ: не JSON, нет номера, ссылка с иной схемой, слишком длинный ответ, код ошибки', async () => {
  let reply: { status: number; body: unknown } = { status: 200, body: '' };
  const srv = await server((_req, res) => json(res, reply.status, reply.body));
  const t = tracker(srv.base);
  for (const [name, body] of [
    ['не JSON', '<html>503</html>'],
    ['пусто', ''],
    ['нет номера', { url: 'https://t.example/1', status: 'done' }],
    ['номер с пробелом', { ref: 'DEV 1', url: 'https://t.example/1', status: 'done' }],
    ['ссылка javascript:', { ref: 'DEV-1', url: 'javascript:alert(1)', status: 'done' }],
    ['ссылка http', { ref: 'DEV-1', url: 'http://tasks.smartup.example/1', status: 'done' }],
    ['больше 16 КБ', { ref: 'DEV-1', url: 'https://t.example/1', status: 'done', pad: 'x'.repeat(20_000) }],
    ['массив', []],
  ] as const) {
    reply = { status: 200, body };
    await expect(t.createTask(input), `создание: ${name}`).rejects.toEqual(failure('bad_response'));
    await expect(t.getTask('DEV-1'), `чтение: ${name}`).rejects.toEqual(failure('bad_response'));
  }
  for (const status of [400, 401, 403, 429, 500, 503]) {
    reply = { status, body: { error: 'Секретный текст ответа таск-менеджера' } };
    await expect(t.createTask(input), String(status)).rejects.toEqual(failure(`http_${status}`));
    await expect(t.getTask('DEV-1'), String(status)).rejects.toEqual(failure(`http_${status}`));
  }
  // В журнале только код сбоя: ни токена, ни текста ответа, ни текста обращения.
  const text = JSON.stringify(logs);
  for (const secret of [TOKEN, 'Секретный текст', 'Не проводится накладная', 'Описание']) expect(text).not.toContain(secret);
  expect(logs.every((entry) => entry.event === 'devtask.tracker_failed')).toBe(true);
});

test('таск-менеджер молчит дольше срока или недоступен: отказ с кодом, запрос не висит', async () => {
  const srv = await server(() => {});
  const started = Date.now();
  await expect(tracker(srv.base, { timeoutMs: 150 }).createTask(input)).rejects.toEqual(failure('timeout'));
  await expect(tracker(srv.base, { timeoutMs: 150 }).getTask('DEV-1')).rejects.toEqual(failure('timeout'));
  expect(Date.now() - started).toBeLessThan(3000);
  // Порт, на котором никто не слушает.
  const dead = await server(() => {});
  await closers.pop()?.();
  const error = await tracker(dead.base).getTask('DEV-1').catch((e: unknown) => e);
  expect(error).toBeInstanceOf(DevTrackerUnavailableError);
  expect((error as DevTrackerUnavailableError).code).toBe('unreachable');
});
