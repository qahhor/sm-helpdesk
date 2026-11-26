import { handleIdeaUploadRequest, isIdeaUploadRequest } from '@/modules/hdi/api/uploads';
import { handleUploadRequest } from '@/modules/hdt/api';

// Ссылка на загрузку файла в карантин (FR-TK-13). Сессия клиента, Origin портала и вход по схеме Zod: в handleUploadRequest.
export const dynamic = 'force-dynamic';

// Изображение идеи (план M7, решение 10): тот же адрес с purpose = "idea" в теле, проверки в handleIdeaUploadRequest.
export async function POST(request: Request): Promise<Response> {
  return (await isIdeaUploadRequest(request)) ? handleIdeaUploadRequest(request, 'presign') : handleUploadRequest(request, 'presign');
}
