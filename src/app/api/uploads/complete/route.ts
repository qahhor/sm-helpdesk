import { handleIdeaUploadRequest, isIdeaUploadRequest } from '@/modules/hdi/api/uploads';
import { handleUploadRequest } from '@/modules/hdt/api';

// Браузер закончил загрузку файла: сверка размера и постановка проверки (FR-TK-13). Проверки в handleUploadRequest.
export const dynamic = 'force-dynamic';

// Изображение идеи (план M7, решение 10): тот же адрес с purpose = "idea" в теле, проверки в handleIdeaUploadRequest.
export async function POST(request: Request): Promise<Response> {
  return (await isIdeaUploadRequest(request)) ? handleIdeaUploadRequest(request, 'complete') : handleUploadRequest(request, 'complete');
}
