import { recordWidgetSuggestTicket } from '@/modules/hdk/api/widget';
import { handleEmbedTickets } from '@/modules/hdt/api/embed';

// Обращения виджета (план M6, задачи 5 и 6). Токен виджета, актор клиента из токена, общие операции модуля hdt.
// GET: мои обращения в организации токена. POST: новое обращение. Исход подсказки "обращение создано" пишет модуль
// знаний: модуль обращений от него не зависит.
export const dynamic = 'force-dynamic';

export function GET(request: Request): Promise<Response> {
  return handleEmbedTickets(request);
}

export function POST(request: Request): Promise<Response> {
  return handleEmbedTickets(request, { afterCreate: recordWidgetSuggestTicket });
}
