import { handleSimilarRequest } from '@/modules/hdi/api/similar';

// Похожие идеи при наборе (FR-IDEA-02, план M7, задача 3). Сессия клиента, Zod и предел частоты: в handleSimilarRequest.
export const dynamic = 'force-dynamic';

export function GET(request: Request): Promise<Response> {
  return handleSimilarRequest(request);
}
