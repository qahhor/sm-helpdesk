import * as z from 'zod';
import { LOCALES } from '@/i18n/locales';
import { problemResponse } from '@/modules/hdc/api';
import { isHdpError } from '@/modules/hdp/api';
import { activeAnnouncements, dismissAnnouncement } from '@/modules/hdp/api/announcements';
import { withEmbedRequest } from '@/modules/hdu/api/embed';

// Объявления в панели виджета (ТЗ FR-ANN-02, 04; план M5c, задача 6, решение 24). Только токен виджета, актор клиента
// из токена. GET: действующие объявления аудитории клиента без закрытых им; объявление модуля только при модуле из
// формы или подсказки. POST: закрыть баннер; закрытие то же, что в портале.
export const dynamic = 'force-dynamic';

export function GET(request: Request): Promise<Response> {
  return withEmbedRequest(request, async (ctx) => {
    const params = new URL(request.url).searchParams;
    const locale = z.enum(LOCALES).catch('ru').parse(params.get('locale'));
    const moduleId = z.uuid().safeParse(params.get('module'));
    const list = await activeAnnouncements(ctx.actor, { locale, surface: 'widget', ...(moduleId.success ? { moduleId: moduleId.data } : {}) });
    return Response.json({ items: list.map((a) => ({ id: a.announcementId, kind: a.kind, title: a.title, body: a.body })) });
  });
}

export function POST(request: Request): Promise<Response> {
  return withEmbedRequest(request, async (ctx, body) => {
    try {
      await dismissAnnouncement(ctx, { announcementId: (body as { announcementId?: unknown } | null)?.announcementId });
      return new Response(null, { status: 204 });
    } catch (error) {
      if (!isHdpError(error)) throw error;
      return problemResponse(error.code === 'not_found' ? 404 : 400, error.code);
    }
  });
}
