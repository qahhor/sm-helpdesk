import { clientSolutionFileResponse } from '@/modules/hdk/api/client';
import { currentClient } from '@/modules/hdu/api';

// Изображение решения для клиента (план M5, задача 4; решение 16): файл отдаётся, только если он упомянут в видимой
// клиенту строке hdk_published этого решения. Поток из хранилища с типом от портала и nosniff.
export const dynamic = 'force-dynamic';

export async function GET(_request: Request, ctx: RouteContext<'/[locale]/help/a/[ref]/files/[id]'>): Promise<Response> {
  const { ref, id } = await ctx.params;
  return clientSolutionFileResponse(await currentClient(), { ref, fileId: id });
}
