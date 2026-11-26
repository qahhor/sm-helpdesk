import { ideaFileResponse } from '@/modules/hdi/api/files';
import { currentStaff } from '@/modules/hdu/api';

// Изображение идеи для сотрудника (план M7, решение 10): модератор обязан просмотреть снимки до публикации. Только
// чистый файл; тип задаёт портал.
export const dynamic = 'force-dynamic';

export async function GET(_request: Request, ctx: RouteContext<'/[locale]/agent/ideas/[number]/files/[id]'>): Promise<Response> {
  const { number, id } = await ctx.params;
  const staff = await currentStaff();
  return ideaFileResponse(staff?.actor ?? null, { number, fileId: id });
}
