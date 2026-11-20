import { handleTelegramWebhook } from '@/modules/hdn/api';
import { handleTelegramUpdate } from '@/modules/hdu/api';

// Вебхук бота Telegram (задача 16, решение 0018). Проверки и повторная доставка: handleTelegramWebhook,
// что делать с событием: модуль идентичности.
export const dynamic = 'force-dynamic';

export function POST(request: Request): Promise<Response> {
  return handleTelegramWebhook(request, handleTelegramUpdate);
}
