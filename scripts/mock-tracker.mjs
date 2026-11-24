// Ложный таск-менеджер Smartup для разработки и контрактных тестов (ТЗ 7.9, FR-DEV-03, 04; план M8, задача 8,
// решение 13). Только локально.
//
// ВНИМАНИЕ: описание настоящего API таск-менеджера Smartup не получено. Этот сервер отвечает по ПРЕДПОЛАГАЕМОМУ
// договору из docs/integrations/dev-tracker.md. Когда придёт настоящее описание, меняются только этот файл и
// реализация src/modules/hdw/dev-tracker/smartup.ts.
//
// Договор:
//   POST /tasks            Authorization: Bearer <токен>; тело { title, descriptionMd, kind, priority?, moduleCode?,
//                          sourceUrl } -> 201 { ref, url }
//   GET  /tasks/:ref       Authorization: Bearer <токен> -> 200 { ref, url, status, version? } или 404
//   вебхук портала         POST <адрес портала>/api/webhooks/tracker, тело { event: "task.status_changed", ref, status,
//                          version? }, заголовки X-Tracker-Timestamp (секунды) и X-Tracker-Signature:
//                          sha256=<HMAC-SHA256 от "<секунды>.<тело>" общим секретом, шестнадцатеричная запись>
//
// Управление для тестов (без токена):
//   GET    /__tasks                 задачи и то, что портал прислал при их создании
//   DELETE /__tasks                 забыть всё и снять сбои
//   POST   /__tasks/:ref/status     { status, version?, notify? } сменить статус; notify: true шлёт вебхук порталу
//   POST   /__control               { fail?: boolean, delayMs?: number } отвечать 503 или с задержкой
//
// Портал направляют сюда переменными DEV_TRACKER=smartup, DEV_TRACKER_URL=http://localhost:3194,
// DEV_TRACKER_TOKEN и DEV_TRACKER_WEBHOOK_SECRET (http допускается только когда сам портал на localhost).
//
// Запуск: pnpm dev:tracker
import { createHmac } from 'node:crypto';
import { createServer } from 'node:http';

export const MOCK_TRACKER_PORT = Number(process.env.MOCK_TRACKER_PORT ?? 3194);
/** Значения только для ложного сервера на машине разработчика: настоящих секретов в репозитории нет. */
export const MOCK_TRACKER_TOKEN = process.env.DEV_TRACKER_TOKEN ?? 'mock-tracker-token-for-localhost-only';
export const MOCK_TRACKER_SECRET = process.env.DEV_TRACKER_WEBHOOK_SECRET ?? 'mock-tracker-webhook-secret-localhost-only';
export const MOCK_TRACKER_WEBHOOK_URL = process.env.MOCK_TRACKER_WEBHOOK_URL ?? 'http://localhost:3000/api/webhooks/tracker';

export const TRACKER_TIMESTAMP_HEADER = 'x-tracker-timestamp';
export const TRACKER_SIGNATURE_HEADER = 'x-tracker-signature';

/**
 * Подпись вебхука таск-менеджера: sha256=<HMAC-SHA256 от "<секунды>.<тело>">.
 * @param {string} secret
 * @param {number} unixSeconds
 * @param {string} rawBody
 */
export function signTrackerWebhook(secret, unixSeconds, rawBody) {
  return `sha256=${createHmac('sha256', secret).update(`${unixSeconds}.${rawBody}`).digest('hex')}`;
}

/** @typedef {{ ref: string; url: string; status: string; version?: string }} MockTask */
/** @typedef {{ title?: unknown; descriptionMd?: unknown; kind?: unknown; priority?: unknown; moduleCode?: unknown; sourceUrl?: unknown }} CreateBody */

/**
 * @param {{ port?: number; token?: string; secret?: string; webhookUrl?: string }} [opts] port 0: любой свободный порт
 */
export function startMockTracker(opts = {}) {
  const token = opts.token ?? MOCK_TRACKER_TOKEN;
  const secret = opts.secret ?? MOCK_TRACKER_SECRET;
  /** @type {Map<string, MockTask>} */
  const tasks = new Map();
  /** @type {{ ref: string; body: CreateBody }[]} */
  const created = [];
  const control = { fail: false, delayMs: 0, webhookUrl: opts.webhookUrl ?? MOCK_TRACKER_WEBHOOK_URL };
  let serial = 0;
  /** @type {import('node:http').Server} */
  let server;

  const baseUrl = () => {
    const address = server.address();
    return `http://127.0.0.1:${address && typeof address === 'object' ? address.port : (opts.port ?? MOCK_TRACKER_PORT)}`;
  };
  const json = (/** @type {import('node:http').ServerResponse} */ res, /** @type {number} */ status, /** @type {unknown} */ body) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  const readJson = (/** @type {import('node:http').IncomingMessage} */ req) =>
    new Promise((done, reject) => {
      let text = '';
      req.on('data', (chunk) => (text += chunk));
      req.on('end', () => {
        try {
          done(text ? JSON.parse(text) : {});
        } catch (error) {
          reject(error);
        }
      });
      req.on('error', reject);
    });

  /**
   * Вебхук о смене статуса задачи на адрес портала. Возвращает код ответа портала.
   * @param {string} ref
   * @param {{ url?: string; secret?: string; timestamp?: number; status?: string }} [how]
   */
  async function sendWebhook(ref, how = {}) {
    const task = tasks.get(ref.toLowerCase());
    if (!task) throw new Error(`ложный таск-менеджер: нет задачи ${ref}`);
    const body = JSON.stringify({ event: 'task.status_changed', ref: task.ref, status: how.status ?? task.status, ...(task.version ? { version: task.version } : {}) });
    const timestamp = how.timestamp ?? Math.floor(Date.now() / 1000);
    const response = await fetch(how.url ?? control.webhookUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json', [TRACKER_TIMESTAMP_HEADER]: String(timestamp), [TRACKER_SIGNATURE_HEADER]: signTrackerWebhook(how.secret ?? secret, timestamp, body) },
      body,
    });
    return { status: response.status, body, timestamp };
  }

  /**
   * Сменить статус задачи, как это сделал бы разработчик в таск-менеджере.
   * @param {string} ref
   * @param {string} status
   * @param {string} [version]
   */
  function setStatus(ref, status, version) {
    const task = tasks.get(ref.toLowerCase());
    if (!task) throw new Error(`ложный таск-менеджер: нет задачи ${ref}`);
    task.status = status;
    if (version) task.version = version;
    return task;
  }

  server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const handle = async () => {
      // --- Управление для тестов ---
      if (url.pathname === '/__tasks') {
        if (req.method === 'DELETE') {
          tasks.clear();
          created.length = 0;
          control.fail = false;
          control.delayMs = 0;
        }
        return json(res, 200, { tasks: [...tasks.values()], created });
      }
      if (url.pathname === '/__control' && req.method === 'POST') {
        const data = /** @type {{ fail?: unknown; delayMs?: unknown }} */ (await readJson(req));
        if (typeof data.fail === 'boolean') control.fail = data.fail;
        if (typeof data.delayMs === 'number') control.delayMs = data.delayMs;
        return json(res, 200, { fail: control.fail, delayMs: control.delayMs });
      }
      const statusMatch = /^\/__tasks\/([^/]+)\/status$/.exec(url.pathname);
      if (statusMatch && req.method === 'POST') {
        const ref = decodeURIComponent(statusMatch[1] ?? '');
        const data = /** @type {{ status?: unknown; version?: unknown; notify?: unknown }} */ (await readJson(req));
        if (!tasks.has(ref.toLowerCase()) || typeof data.status !== 'string') return json(res, 404, { error: 'not_found' });
        const task = setStatus(ref, data.status, typeof data.version === 'string' ? data.version : undefined);
        const webhook = data.notify === true ? await sendWebhook(ref).then((sent) => ({ status: sent.status }), () => ({ status: 0 })) : null;
        return json(res, 200, { task, webhook });
      }

      // --- API таск-менеджера ---
      if (control.delayMs > 0) await new Promise((resolve) => setTimeout(resolve, control.delayMs));
      if (control.fail) return json(res, 503, { error: 'unavailable' });
      if (req.headers.authorization !== `Bearer ${token}`) return json(res, 401, { error: 'unauthorized' });
      if (url.pathname === '/tasks' && req.method === 'POST') {
        const body = /** @type {CreateBody} */ (await readJson(req));
        if (typeof body.title !== 'string' || body.title === '' || typeof body.descriptionMd !== 'string' || (body.kind !== 'bug' && body.kind !== 'feature') || typeof body.sourceUrl !== 'string')
          return json(res, 422, { error: 'invalid_task' });
        const ref = `DEV-${1000 + ++serial}`;
        const task = { ref, url: `${baseUrl()}/tasks/${ref}`, status: 'todo' };
        tasks.set(ref.toLowerCase(), task);
        created.push({ ref, body });
        return json(res, 201, { ref: task.ref, url: task.url });
      }
      const taskMatch = /^\/tasks\/([^/]+)$/.exec(url.pathname);
      if (taskMatch && req.method === 'GET') {
        const task = tasks.get(decodeURIComponent(taskMatch[1] ?? '').toLowerCase());
        return task ? json(res, 200, task) : json(res, 404, { error: 'not_found' });
      }
      return json(res, 404, { error: 'not_found' });
    };
    handle().catch(() => {
      if (!res.headersSent) json(res, 400, { error: 'bad_request' });
      else res.end();
    });
  });
  server.listen(opts.port ?? MOCK_TRACKER_PORT, '127.0.0.1');

  return {
    server,
    token,
    secret,
    tasks,
    created,
    control,
    /** Адрес сервера: читать после события listening. */
    baseUrl,
    /** @returns {Promise<void>} */
    ready: () => new Promise((resolve) => (server.listening ? resolve() : server.once('listening', () => resolve()))),
    /**
     * Завести задачу, как будто её создали в таск-менеджере вручную.
     * @param {MockTask} task
     */
    add(task) {
      tasks.set(task.ref.toLowerCase(), { ...task });
    },
    setStatus,
    sendWebhook,
    /** @returns {Promise<void>} */
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

if (import.meta.main) {
  startMockTracker();
  console.log(`Ложный таск-менеджер: http://localhost:${MOCK_TRACKER_PORT} (задачи: /__tasks, вебхук уходит на ${MOCK_TRACKER_WEBHOOK_URL})`);
}
