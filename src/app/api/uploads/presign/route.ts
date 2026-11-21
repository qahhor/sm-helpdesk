import { handleUploadRequest } from '@/modules/hdt/api';

// Ссылка на загрузку файла в карантин (FR-TK-13). Сессия клиента, Origin портала и вход по схеме Zod: в handleUploadRequest.
export const dynamic = 'force-dynamic';

export function POST(request: Request): Promise<Response> {
  return handleUploadRequest(request, 'presign');
}
