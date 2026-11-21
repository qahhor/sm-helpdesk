import { handleCspReport } from '@/modules/hdc/api';

// Отчёты браузера о нарушениях CSP (проверка main, S9). Входа не требует: проверки в handleCspReport.
export const dynamic = 'force-dynamic';

export function POST(request: Request): Promise<Response> {
  return handleCspReport(request);
}
