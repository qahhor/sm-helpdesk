import { handleEmbedSolution } from '@/modules/hdk/api/widget';

// Решение в панели виджета (план M6, задача 5): текст только из hdk_published, "Помогло" и "Не помогло". Токен виджета.
export const dynamic = 'force-dynamic';

export async function GET(request: Request, ctx: RouteContext<'/api/embed/solutions/[ref]'>): Promise<Response> {
  return handleEmbedSolution(request, (await ctx.params).ref);
}

export async function POST(request: Request, ctx: RouteContext<'/api/embed/solutions/[ref]'>): Promise<Response> {
  return handleEmbedSolution(request, (await ctx.params).ref);
}
