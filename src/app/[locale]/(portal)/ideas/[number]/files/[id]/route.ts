import { ideaFileResponse } from '@/modules/hdi/api/files';
import { currentClient } from '@/modules/hdu/api';

// Изображение идеи для клиента (план M7, решение 10): видимая идея, только чистый файл; чужим только у опубликованной.
export const dynamic = 'force-dynamic';

export async function GET(_request: Request, ctx: RouteContext<'/[locale]/ideas/[number]/files/[id]'>): Promise<Response> {
  const { number, id } = await ctx.params;
  const client = await currentClient();
  return ideaFileResponse(client?.actor ?? null, { number, fileId: id });
}
