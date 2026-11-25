import { staffSolutionFileResponse } from '@/modules/hdk/api/files';
import { currentStaff } from '@/modules/hdu/api';

// Изображение решения для сотрудника (план M5, задача 3; решение 16): любой сотрудник, файл этой статьи, только
// после проверки антивирусом. Файл отдаётся потоком с типом от портала и запретом угадывать тип.
export const dynamic = 'force-dynamic';

export async function GET(_request: Request, ctx: RouteContext<'/[locale]/agent/solutions/[number]/files/[id]'>): Promise<Response> {
  const { number, id } = await ctx.params;
  return staffSolutionFileResponse(await currentStaff(), {
    number,
    fileId: id,
  });
}
