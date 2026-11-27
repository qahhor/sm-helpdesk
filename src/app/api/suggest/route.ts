import { handleWidgetSuggest } from '@/modules/hdk/api/widget';
import { problemForSuggest } from '@/modules/hdp/api/client';

// Подсказка решений в панели виджета (план M6, задача 5). Только токен виджета в заголовке Authorization: страницы
// портала зовут подсказку серверным действием по сессии. Проверки, пределы и исходы: в handleWidgetSuggest.
// Ответ дополняется известной проблемой (план M5c, решение 13): подсказку и проблему собирает этот обработчик,
// вызывая модуль знаний и модуль проблем по отдельности.
export const dynamic = 'force-dynamic';

export function POST(request: Request): Promise<Response> {
  return handleWidgetSuggest(request, { extra: async (ctx, body) => ({ knownProblem: await problemForSuggest(ctx.actor, body) }) });
}
