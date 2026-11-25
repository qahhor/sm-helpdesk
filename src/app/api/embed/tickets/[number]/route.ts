import { handleEmbedTicket } from '@/modules/hdt/api/embed';

// Обращение в виджете (план M6, задача 6; решение 13): переписка, ответ, вложения, подтверждение решения. Токен
// виджета; чужое, невидимое и несуществующее обращение неразличимы (строка 15.2 ТЗ).
export const dynamic = 'force-dynamic';

export async function GET(request: Request, ctx: RouteContext<'/api/embed/tickets/[number]'>): Promise<Response> {
  return handleEmbedTicket(request, (await ctx.params).number);
}

export async function POST(request: Request, ctx: RouteContext<'/api/embed/tickets/[number]'>): Promise<Response> {
  return handleEmbedTicket(request, (await ctx.params).number);
}
