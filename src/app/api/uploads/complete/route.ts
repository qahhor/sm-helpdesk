import { handleUploadRequest } from '@/modules/hdt/api';

// Браузер закончил загрузку файла: сверка размера и постановка проверки (FR-TK-13). Проверки в handleUploadRequest.
export const dynamic = 'force-dynamic';

export function POST(request: Request): Promise<Response> {
  return handleUploadRequest(request, 'complete');
}
