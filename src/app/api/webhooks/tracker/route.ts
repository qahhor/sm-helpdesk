import { handleTrackerWebhook } from '@/modules/hdw/api/tracker-webhook';

// Вебхук таск-менеджера Smartup (ТЗ 7.9, FR-DEV-04; план M8, задача 8): смена статуса задачи разработки.
// Подпись, окно времени, предел тела и частоты, схема: handleTrackerWebhook. В ручном режиме адреса нет (404).
export const dynamic = 'force-dynamic';

export function POST(request: Request): Promise<Response> {
  return handleTrackerWebhook(request);
}
