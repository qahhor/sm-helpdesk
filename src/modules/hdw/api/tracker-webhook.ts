import 'server-only';
import * as z from 'zod';
import { logEvent } from '@/lib/log';
import { consumeRateLimit, ipRateKey, problemResponse, readLimited } from '@/modules/hdc/api';
import { RATE_RULES } from '@/modules/hdc/pref';
import { wakeOutbox } from '@/modules/hdn/api/outbox';
import { applyTrackerUpdate } from '../core/dev-task-sync';
import { devTrackerSettings } from '../dev-tracker';
import { mapTrackerStatus } from '../dev-tracker/status-map';
import { DEV_TASK_REF_MAX, DEV_TASK_VERSION_MAX } from '../pref';
import { TRACKER_SIGNATURE_HEADER, TRACKER_TIMESTAMP_HEADER, verifyTrackerSignature } from '../tracker-sign';

// Модуль hdw, слой api: входящий вебхук таск-менеджера Smartup, POST /api/webhooks/tracker (ТЗ 7.9, FR-DEV-04;
// план M8, задача 8).
//
// ВНИМАНИЕ: описание настоящего API не получено. Заголовки, подпись и поля тела здесь это предполагаемый договор
// (docs/integrations/dev-tracker.md). Проверки от договора не зависят и идут в таком порядке: режим, метод, частота
// с адреса, размер тела, подпись и окно времени, схема. Без верной подписи не читается и не пишется ничего.
//
// Неизвестный номер задачи, незнакомый статус и чужое событие отвечают 200 и ничего не делают: по ответу нельзя
// узнать, какие задачи известны порталу. Повтор того же события статус не меняет и второго напоминания не даёт.

/** Предел тела: в событии только номер задачи, статус и версия. */
const BODY_LIMIT = 16 * 1024;
const SYSTEM = { type: 'system', job: 'tracker.webhook' } as const;
const STATUS_EVENT = 'task.status_changed';

const eventBody = z.object({
  event: z.string().min(1).max(60),
  ref: z
    .string()
    .min(1)
    .max(DEV_TASK_REF_MAX)
    .regex(/^[^\s\p{Cc}]+$/u),
  status: z.string().max(60).optional(),
  version: z.string().trim().max(DEV_TASK_VERSION_MAX).nullish(),
});

const accepted = (): Response => new Response(null, { status: 200, headers: { 'Cache-Control': 'no-store' } });

export async function handleTrackerWebhook(request: Request, opts: { now?: Date } = {}): Promise<Response> {
  const settings = devTrackerSettings();
  // В ручном режиме таск-менеджер порталу не пишет: адреса как будто нет.
  if (settings.mode !== 'smartup') return problemResponse(404, 'not_found');
  if (request.method !== 'POST') return problemResponse(405, 'method_not_allowed', { Allow: 'POST' });
  const limit = await consumeRateLimit(ipRateKey('tracker-webhook:ip', request.headers), RATE_RULES.trackerWebhookPerIp);
  if (!limit.allowed) return problemResponse(429, 'rate_limited', { 'Retry-After': String(limit.retryAfterSec) });
  const text = await readLimited(request, BODY_LIMIT);
  if (text === null) return problemResponse(413, 'too_large');

  const check = verifyTrackerSignature({
    secret: settings.webhookSecret,
    timestamp: request.headers.get(TRACKER_TIMESTAMP_HEADER),
    signature: request.headers.get(TRACKER_SIGNATURE_HEADER),
    rawBody: text,
    now: opts.now ?? new Date(),
  });
  if (check !== 'ok') {
    // Причина только в журнале: отправителю всегда один и тот же ответ.
    logEvent('warn', 'devtask.webhook_refused', { reason: check });
    return problemResponse(401, 'bad_signature');
  }

  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return problemResponse(400, 'invalid_json');
  }
  const parsed = eventBody.safeParse(json);
  if (!parsed.success) return problemResponse(400, 'invalid_body');
  const data = parsed.data;
  if (data.event !== STATUS_EVENT) return accepted();
  const status = mapTrackerStatus(data.status);
  if (!status) {
    logEvent('warn', 'devtask.unknown_status', { ref: data.ref, status: (data.status ?? '').slice(0, 60) });
    return accepted();
  }
  const result = await applyTrackerUpdate(SYSTEM, data.ref, { status, ...(data.version ? { version: data.version } : {}) });
  // Письма исполнителям о закрытой задаче уже в очереди исходящих: отправка будится после фиксации.
  if (result && result.reminded > 0) await wakeOutbox();
  return accepted();
}
