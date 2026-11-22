import 'server-only';
import { enqueue, problemResponse, readLimited } from '@/modules/hdc/api';
import { recordInbound } from '../core/inbound';
import { recordDelivery } from '../core/outbox';
import { getEmailProvider, WebhookSignatureError } from '../provider';

// Вебхук почтового сервиса (раздел 12.2 "POST /api/webhooks/email", решение 10 вехи M4). Подпись Svix проверяется
// первой: без неё ответ 401 и ничего не пишется. Письмо: строка входящих и задача разбора (повтор письма задачу не
// ставит), событие доставки: статус очереди исходящих, неизвестное событие: 200 без записи.

/** Предел тела запроса: в вебхуке только сведения о письме, текст и вложения забираются отдельно. */
const MAX_BODY_BYTES = 256 * 1024;
const SYSTEM = { type: 'system', job: 'email.webhook' } as const;

export async function handleEmailWebhook(request: Request): Promise<Response> {
  const body = await readLimited(request, MAX_BODY_BYTES);
  if (body === null) return problemResponse(413, 'too_large');
  const provider = await getEmailProvider();
  let event;
  try {
    event = await provider.verifyWebhook(body, request.headers);
  } catch (error) {
    if (error instanceof WebhookSignatureError) return problemResponse(401, 'bad_signature');
    return problemResponse(400, 'invalid_body');
  }
  if (event.kind === 'received') {
    const { inboundId, created } = await recordInbound(SYSTEM, event);
    if (created) await enqueue('email.inbound', { inboundId });
  } else if (event.kind === 'delivery') await recordDelivery(SYSTEM, event);
  return new Response(null, { status: 200, headers: { 'Cache-Control': 'no-store' } });
}
