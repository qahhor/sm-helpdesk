import 'server-only';
import * as z from 'zod';
import { LOCALES } from '@/i18n/locales';
import { problemResponse } from '@/modules/hdc/api';
import { listActiveModules } from '@/modules/hdr/api';
import { type EmbedContext, withEmbedRequest } from '@/modules/hdu/api/embed';
import { confirmResolution, createWidgetTicket, getTicket, listTickets, replyToTicket, type TicketView } from '../api';
import { isHdtError } from '../error';

// Обращения в виджете (план M6, задачи 5 и 6; FR-WG-06; решения 12, 13 и 14). Обработчики /api/embed/form,
// /api/embed/tickets и /api/embed/tickets/{номер}. Токен виджета в заголовке Authorization (withEmbedRequest),
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

/**
 * GET /api/embed/tickets: мои обращения в этой организации (решение 13), курсор на следующую страницу.
 * POST /api/embed/tickets: новое обращение общей операцией с источником по платформе токена (решение 12).
 */
export function handleEmbedTickets(request: Request, opts: { afterCreate?: AfterWidgetTicket } = {}): Promise<Response> {
  return withEmbedRequest(request, async (ctx, body) => {
    try {
      if (request.method === 'GET') {
        const cursor = new URL(request.url).searchParams.get('cursor') ?? undefined;
        const page = await listTickets(ctx, { scope: 'mine', cursor });
        return Response.json({
          items: page.items.map((row) => ({ number: row.number, title: row.title, status: row.status, modifiedOn: row.modifiedOn.toISOString() })),
          nextCursor: page.nextCursor,
        });
      }
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

/** Обращение в виджете: переписка, ответ, вложения и подтверждение решения (решение 13). Только поля клиента. */
export type EmbedTicketView = {
  number: number;
  title: string;
  description: string;
  status: TicketView['status'];
  createdOn: string;
  turn: TicketView['turn'];
  isMine: boolean;
  merged: boolean;
  attachments: EmbedAttachment[];
  messages: { messageId: string; authorType: 'client' | 'support'; authorName: string | null; isMine: boolean; isAuto: boolean; body: string; createdOn: string; attachments: EmbedAttachment[] }[];
  can: { reply: boolean; confirm: boolean };
};
type EmbedAttachment = { attachmentId: string; fileName: string; size: number; scanStatus: string; isImage: boolean };

const attachmentOf = (a: TicketView['attachments'][number]): EmbedAttachment => ({ attachmentId: a.attachmentId, fileName: a.fileName, size: a.size, scanStatus: a.scanStatus, isImage: a.isImage });

/** Клиентская проекция страницы обращения для виджета. Ответ сотрудника подписан поддержкой, без имени (FR-LINE-07). */
export function embedTicketView(view: TicketView): EmbedTicketView {
  return {
    number: view.number,
    title: view.title,
    description: view.description,
    status: view.status,
    createdOn: view.createdOn.toISOString(),
    turn: view.turn,
    isMine: view.isMine,
    merged: view.merged,
    attachments: view.attachments.map(attachmentOf),
    messages: view.messages.map((m) => ({
      messageId: m.messageId,
      authorType: m.authorType === 'client' ? 'client' : 'support',
      authorName: m.authorType === 'client' ? m.authorName : null,
      isMine: m.isMine,
      isAuto: m.isAuto,
      body: m.body,
      createdOn: m.createdOn.toISOString(),
      attachments: m.attachments.map(attachmentOf),
    })),
    can: { reply: view.can.reply, confirm: view.can.confirm },
  };
}

const actionInput = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('reply'), body: z.string(), attachmentIds: z.array(z.string()).max(100).default([]) }),
  z.strictObject({ action: z.literal('confirm') }),
]);

/**
 * GET /api/embed/tickets/{номер}: чужое, невидимое и несуществующее неразличимы: 404 (строка 15.2 ТЗ).
 * POST: ответ с файлами или подтверждение решения общими операциями модуля.
 */
export function handleEmbedTicket(request: Request, numberRaw: string): Promise<Response> {
  return withEmbedRequest(request, async (ctx, body) => {
    try {
      if (request.method === 'GET') {
        const view = await getTicket(ctx, numberRaw);
        if (!view) return problemResponse(404, 'not_found');
        return Response.json(embedTicketView(view));
      }
      const parsed = actionInput.safeParse(body);
      if (!parsed.success) return problemResponse(400, 'invalid_input');
      if (parsed.data.action === 'reply') await replyToTicket(ctx, { number: numberRaw.replace(/^SUP-/i, ''), body: parsed.data.body, attachmentIds: parsed.data.attachmentIds });
      else await confirmResolution(ctx, numberRaw.replace(/^SUP-/i, ''));
      const view = await getTicket(ctx, numberRaw);
      if (!view) return problemResponse(404, 'not_found');
      return Response.json(embedTicketView(view));
    } catch (error) {
      return hdtProblem(error);
    }
  });
}
