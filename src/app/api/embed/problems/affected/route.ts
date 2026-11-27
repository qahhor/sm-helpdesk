import { problemResponse } from '@/modules/hdc/api';
import { isHdpError } from '@/modules/hdp/api';
import { reportAffected } from '@/modules/hdp/api/client';
import { withEmbedRequest } from '@/modules/hdu/api/embed';

// "Меня это тоже затронуло" в панели виджета (ТЗ FR-KP-08, 14.5; план M5c, задача 4, решение 14). Только токен
// виджета; актор клиента и платформа из проверенного токена, номер проблемы, описание и подсказки из тела. Ответ:
// номер своего обращения по проблеме (новое 201 или уже созданное 200).
export const dynamic = 'force-dynamic';

const STATUS: Partial<Record<string, number>> = { invalid_input: 400, not_found: 404, rate_limited: 429, forbidden: 403 };

export function POST(request: Request): Promise<Response> {
  return withEmbedRequest(request, async (ctx, body) => {
    try {
      const input = typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {};
      const { number, created } = await reportAffected(ctx, { problemNumber: input.problemNumber, locale: input.locale, description: input.description, context: input.context, platform: ctx.platform });
      return Response.json({ number, created }, { status: created ? 201 : 200 });
    } catch (error) {
      if (!isHdpError(error)) {
        const code = (error as { code?: unknown } | null)?.code;
        // Отказы операции создания обращения (пределы, проверка полей) приходят кодом модуля обращений.
        if (typeof code === 'string' && code in STATUS) return problemResponse(STATUS[code]!, code);
        throw error;
      }
      return problemResponse(STATUS[error.code] ?? 400, error.code, error.retryAfterSec ? { 'Retry-After': String(error.retryAfterSec) } : {});
    }
  });
}
