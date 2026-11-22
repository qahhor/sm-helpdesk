import 'server-only';
import { problemResponse, readLimited } from '@/modules/hdc/api';
import { forgetUpdate, recordUpdate } from './core/telegram-updates';
import { getTelegramBot } from './telegram';
import { type TelegramUpdate, telegramUpdate } from './telegram-update';

// Вебхук бота Telegram: POST /api/webhooks/telegram (задача 16, решение 0018).
// Что делать с событием, решает модуль идентичности: обработчик приходит параметром,
// так модуль уведомлений не зависит от модуля идентичности.

const BODY_LIMIT = 64 * 1024;

/**
 * Принимает событие Telegram: бот выключен 404, чужой секрет 401, тело больше 64 КБ 413, не по схеме 400,
 * другие методы 405. Повтор того же события отвечает 200 и ничего не делает. Сбой обработки снимает номер
 * события и отвечает 500: Telegram пришлёт событие снова. Текст сообщений в журнал не попадает.
 */
export async function handleTelegramWebhook(request: Request, onUpdate: (update: TelegramUpdate) => Promise<void>): Promise<Response> {
  const bot = getTelegramBot();
  if (!bot.enabled) return problemResponse(404, 'not_found');
  if (request.method !== 'POST') return problemResponse(405, 'method_not_allowed', { Allow: 'POST' });
  if (!bot.checkSecret(request.headers.get('x-telegram-bot-api-secret-token'))) return problemResponse(401, 'unauthorized');

  const text = await readLimited(request, BODY_LIMIT);
  if (text === null) return problemResponse(413, 'too_large');
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return problemResponse(400, 'invalid_json');
  }
  const parsed = telegramUpdate.safeParse(json);
  if (!parsed.success) return problemResponse(400, 'invalid_update');

  const update = parsed.data;
  if (!(await recordUpdate(update.update_id))) return new Response(null, { status: 200 });
  try {
    await onUpdate(update);
  } catch (error) {
    await forgetUpdate(update.update_id);
    console.error(`Событие Telegram ${update.update_id} не обработано: ${error instanceof Error ? error.name : 'ошибка'}`);
    return problemResponse(500, 'internal_error');
  }
  return new Response(null, { status: 200 });
}
