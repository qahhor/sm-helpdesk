import { handleAttachmentRequest } from '@/modules/hdt/api';

// Скачивание вложения после проверки (FR-TK-13): сессия клиента, права через политики RLS, 303 на ссылку хранилища.
export const dynamic = 'force-dynamic';

export async function GET(request: Request, ctx: RouteContext<'/api/attachments/[id]'>): Promise<Response> {
  const { id } = await ctx.params;
  return handleAttachmentRequest(request, id);
}
