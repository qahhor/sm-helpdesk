import 'server-only';
import * as z from 'zod';
import { LOCALES } from '@/i18n/locales';
import { problemResponse } from '@/modules/hdc/api';
import { listActiveModules } from '@/modules/hdr/api';
import { type EmbedContext, withEmbedRequest } from '@/modules/hdu/api/embed';
import { createWidgetTicket } from '../api';
import { isHdtError } from '../error';

// Обращения в виджете (план M6, задачи 5 и 6; FR-WG-06; решения 12, 13 и 14). Обработчики /api/embed/form и
// /api/embed/tickets. Токен виджета в заголовке Authorization (withEmbedRequest),
// актор клиента из проверенного токена, дальше те же операции модуля и те же политики RLS, что у страниц портала.
// Своей логики сроков, прав и ответов у виджета нет. Ответы несут только клиентскую проекцию: внутренних заметок,
// имён сотрудников, сигнатур и тегов в них нет (раздел "На что смотреть", пункт 8).

const STATUS_BY_CODE: Partial<Record<string, number>> = {
  invalid_input: 400,
  not_found: 404,
  forbidden: 403,
  rate_limited: 429,
  too_many_files: 400,
  file_unavailable: 409,
  transition_refused: 409,
  merged: 409,
};

/** Ошибка модуля как ответ application/problem+json с кодом. Прочие ошибки идут дальше. */
function hdtProblem(error: unknown): Response {
  if (!isHdtError(error)) throw error;
  const headers: Record<string, string> = error.retryAfterSec ? { 'Retry-After': String(error.retryAfterSec) } : {};
  return problemResponse(STATUS_BY_CODE[error.code] ?? 400, error.code, headers);
}

const localeOf = (request: Request) => z.enum(LOCALES).catch('ru').parse(new URL(request.url).searchParams.get('locale'));

/** GET /api/embed/form: действующие модули для поля "Модуль" (UX-C-09) с кодом для подсказки модуля. */
export function handleEmbedForm(request: Request): Promise<Response> {
  return withEmbedRequest(request, async (ctx) => {
    const modules = await listActiveModules(ctx.actor, localeOf(request));
    return Response.json({ modules: modules.map((m) => ({ id: m.moduleId, code: m.code, name: m.name })) });
  });
}

/** Исход подсказки "обращение создано": пишет модуль знаний, поэтому его передаёт обработчик маршрута. */
export type AfterWidgetTicket = (ctx: EmbedContext, input: { sessionId: unknown; ticketId: string }) => Promise<void>;

/** POST /api/embed/tickets: новое обращение общей операцией с источником по платформе токена (решение 12). */
export function handleEmbedTickets(request: Request, opts: { afterCreate?: AfterWidgetTicket } = {}): Promise<Response> {
  return withEmbedRequest(request, async (ctx, body) => {
    try {
      const created = await createWidgetTicket(ctx, body, { platform: ctx.platform });
      const sessionId = (body as { suggestSession?: unknown } | null)?.suggestSession;
      // Сбой записи исхода подсказки обращение не отменяет.
      if (opts.afterCreate && sessionId) await opts.afterCreate(ctx, { sessionId, ticketId: created.ticketId }).catch(() => undefined);
      return Response.json({ number: created.number }, { status: 201 });
    } catch (error) {
      return hdtProblem(error);
    }
  });
}
