import type { NextRequest } from 'next/server';
import { getTranslations } from 'next-intl/server';
import { isLocale } from '@/i18n/locales';
import { isOwnNavigation } from '@/modules/hdc/api';
import { buildCsv, CSV_MAX_ROWS, exportFileName, exportMetrics, isHdtError } from '@/modules/hdt/api';
import { currentStaff } from '@/modules/hdu/api';

// Выгрузка показателей в CSV (FR-MET-04; план M8, задача 9, решение 16). Только сотрудник из проверенной сессии;
// права (Customer Care, продукт, администратор, руководители линий), предел частоты и запись в журнал аудита
// делает модуль hdt. Ответ не кешируется и отдаётся файлом.
export const dynamic = 'force-dynamic';

const STATUS: Record<string, number> = { forbidden: 403, invalid_input: 400, rate_limited: 429 };

const plain = (status: number, extra: Record<string, string> = {}) =>
  new Response(null, { status, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...extra } });

export async function GET(request: NextRequest, { params }: RouteContext<'/[locale]/agent/metrics/export'>): Promise<Response> {
  const { locale } = await params;
  if (!isLocale(locale)) return plain(404);
  // Выгрузка пишет журнал и тратит попытки: предзагрузка ссылки и переход с чужого сайта её не запускают.
  if (!isOwnNavigation(request.headers)) return plain(403);
  const staff = await currentStaff();
  if (!staff) return plain(401);
  const query = request.nextUrl.searchParams;
  try {
    const out = await exportMetrics(staff, { report: query.get('report') ?? undefined, period: query.get('period') ?? undefined, from: query.get('from') ?? undefined, to: query.get('to') ?? undefined, locale });
    const t = await getTranslations({ locale, namespace: 'agent.metrics' });
    const csv = buildCsv(
      out.columns.map((column) => t(`csv.columns.${column}`)),
      out.rows,
      { notice: out.truncated ? t('export.truncated', { count: CSV_MAX_ROWS }) : undefined },
    );
    return new Response(csv, {
      status: 200,
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="${exportFileName(out.report, out.period)}"`,
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  } catch (error) {
    if (!isHdtError(error)) throw error;
    return plain(STATUS[error.code] ?? 400, error.code === 'rate_limited' && error.retryAfterSec ? { 'Retry-After': String(error.retryAfterSec) } : {});
  }
}
