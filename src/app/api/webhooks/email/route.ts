import { handleEmailWebhook } from '@/modules/hdn/api/webhook-email';

// Вебхук почтового сервиса Resend (раздел 12.2, решение 10 вехи M4): входящие письма и события доставки.
// Подпись, запись и постановка разбора: handleEmailWebhook.
export const dynamic = 'force-dynamic';

export function POST(request: Request): Promise<Response> {
  return handleEmailWebhook(request);
}
