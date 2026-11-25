import { handleWidgetSuggest } from '@/modules/hdk/api/widget';

// Подсказка решений в панели виджета (план M6, задача 5). Только токен виджета в заголовке Authorization: страницы
// портала зовут подсказку серверным действием по сессии. Проверки, пределы и исходы: в handleWidgetSuggest.
export const dynamic = 'force-dynamic';

export function POST(request: Request): Promise<Response> {
  return handleWidgetSuggest(request);
}
