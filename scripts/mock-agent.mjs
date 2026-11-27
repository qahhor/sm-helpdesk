// Местный приёмник событий AI-сотрудника для разработки (ТЗ 7.21 FR-AGT-08; план M8b, задача 9). Только локально:
// портал направляют сюда переменными AGENT_WEBHOOK_URL=http://localhost:3195/events и AGENT_WEBHOOK_SECRET (тот же,
// что ниже). Приёмник проверяет подпись X-Hub-Signature тем же правилом, что вебхуки портала (t=<секунды>,v1=<HMAC-SHA256
// от "<секунды>.<тело>">), печатает вид и номер обращения и хранит события в памяти.
//
//   POST /events      событие портала: 202 при верной подписи, 401 при неверной
//   GET  /__events    принятые события (тела как есть, вместе с токеном запуска: только для разработки)
//   POST /__control   { fail?: boolean } отвечать 503
//
// Запуск: pnpm dev:agent
import { createHmac, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';

const PORT = Number(process.env.MOCK_AGENT_PORT ?? 3195);
/** Значение только для приёмника на машине разработчика: настоящих секретов в репозитории нет. */
const SECRET = process.env.AGENT_WEBHOOK_SECRET ?? 'mock-agent-webhook-secret-localhost-only';
const WINDOW_SEC = 300;

const events = [];
let fail = false;

function verify(header, raw) {
  const match = /^t=(\d+),v1=([0-9a-f]{64})$/.exec(header ?? '');
  if (!match) return false;
  const t = Number(match[1]);
  if (Math.abs(Date.now() / 1000 - t) > WINDOW_SEC) return false;
  const expected = createHmac('sha256', SECRET).update(`${t}.${raw}`).digest('hex');
  return timingSafeEqual(Buffer.from(expected), Buffer.from(match[2]));
}

const server = createServer((req, res) => {
  const chunks = [];
  req.on('data', (chunk) => chunks.push(chunk));
  req.on('end', () => {
    const raw = Buffer.concat(chunks).toString('utf8');
    if (req.method === 'GET' && req.url === '/__events') {
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(events));
      return;
    }
    if (req.method === 'POST' && req.url === '/__control') {
      fail = Boolean(JSON.parse(raw || '{}').fail);
      res.writeHead(204).end();
      return;
    }
    if (req.method !== 'POST' || req.url !== '/events') {
      res.writeHead(404).end();
      return;
    }
    if (fail) {
      res.writeHead(503).end();
      return;
    }
    if (!verify(req.headers['x-hub-signature'], raw)) {
      res.writeHead(401).end();
      return;
    }
    const body = JSON.parse(raw);
    events.push(body);
    console.info(`событие ${body.kind}${body.ticket ? ` по обращению ${body.ticket.number}` : ''}${body.run_token ? ' с токеном запуска' : ''}`);
    res.writeHead(202).end();
  });
});

server.listen(PORT, () => console.info(`Приёмник событий AI-сотрудника: http://localhost:${PORT}/events`));
