import 'server-only';
import * as z from 'zod';
import { LOCALES } from '@/i18n/locales';
import { problemResponse } from '@/modules/hdc/api';
import { withEmbedRequest } from '@/modules/hdu/api/embed';
import type { ClientContext } from '@/modules/hdu/api';
import type { SolutionDoc } from '../doc-schema';
import { HdkError } from '../error';
import { clientSolutionPage, recordSolutionFeedback } from './client';
import { recordSuggestNotHelped, recordSuggestTicket, suggestForWidget } from './suggest';

// Подсказка и решения в панели виджета (план M6, задача 5; FR-SOL-08..15, решения 10 и 14). Обработчики /api/suggest
// и /api/embed/solutions/{номер}. Только токен виджета: сессия портала здесь не читается (withEmbedRequest). Текст
// решения только из hdk_published от имени клиента: внутреннее, черновое и архивное решение клиенту не существует.

const STATUS_BY_CODE: Partial<Record<string, number>> = { invalid_input: 400, not_found: 404, rate_limited: 429, forbidden: 403 };

function hdkProblem(error: unknown): Response {
  if (!(error instanceof HdkError)) throw error;
  const headers: Record<string, string> = error.retryAfterSec ? { 'Retry-After': String(error.retryAfterSec) } : {};
  return problemResponse(STATUS_BY_CODE[error.code] ?? 400, error.code, headers);
}

const notHelpedInput = z.strictObject({ outcome: z.literal('not_helped'), sessionId: z.uuid() });

/**
 * POST /api/suggest. Тело подсказки (описание, сессия формы, язык, модуль, код и текст ошибки из подсказок хозяина)
 * или исход "Не помогло" ({ outcome: 'not_helped', sessionId }). Сверх предела подсказка просто пуста: форма работает.
 */
export function handleWidgetSuggest(
  request: Request,
  opts: { extra?: (ctx: Pick<ClientContext, 'actor'>, body: unknown) => Promise<Record<string, unknown>> } = {},
): Promise<Response> {
  return withEmbedRequest(request, async (ctx, body) => {
    try {
      const notHelped = notHelpedInput.safeParse(body);
      if (notHelped.success) {
        await recordSuggestNotHelped(ctx, { sessionId: notHelped.data.sessionId });
        return new Response(null, { status: 204 });
      }
      const result = await suggestForWidget(ctx, body);
      // Дополнение ответа другим модулем (известная проблема, план M5c, решение 13): модуль знаний о нём не знает.
      // Сбой дополнения подсказку не ломает.
      const extra = opts.extra ? await opts.extra(ctx, body).catch(() => ({})) : {};
      return Response.json({ ...result, ...extra });
    } catch (error) {
      return hdkProblem(error);
    }
  });
}

/** Исход подсказки "обращение создано" для сессии формы виджета (решение 12 вехи M5). */
export function recordWidgetSuggestTicket(ctx: Parameters<typeof recordSuggestTicket>[0], input: { sessionId: unknown; ticketId: string }): Promise<void> {
  return recordSuggestTicket(ctx, input);
}

/** Решение в панели виджета: только то, что нужно странице решения. */
export type EmbedSolution =
  | { kind: 'solution'; number: number; slug: string; title: string; locale: string; notTranslated: boolean; doc: SolutionDoc }
  | { kind: 'archived'; number: number };

const feedbackInput = z.strictObject({ outcome: z.enum(['helped', 'not_helped']), sessionId: z.uuid().optional() });

/**
 * GET /api/embed/solutions/{номер-slug}?locale=: решение на языке панели или по цепочке языков (FR-SOL-10), иначе 404.
 * POST: "Помогло" или "Не помогло" с сессией формы (FR-SOL-11, 13). Изображения решения в панели не показываются:
 * файл решения отдаётся по сессии портала, а ссылка с заголовком Authorization в теге img невозможна.
 */
export function handleEmbedSolution(request: Request, ref: string): Promise<Response> {
  return withEmbedRequest(request, async (ctx, body) => {
    try {
      const locale = z.enum(LOCALES).catch('ru').parse(new URL(request.url).searchParams.get('locale'));
      const page = await clientSolutionPage(ctx, { ref, locale });
      if (!page) return problemResponse(404, 'not_found');
      if (request.method === 'GET') {
        const result: EmbedSolution =
          page.kind === 'archived'
            ? { kind: 'archived', number: page.number }
            : {
                kind: 'solution',
                number: page.solution.number,
                slug: page.solution.slug,
                title: page.solution.title,
                locale: page.solution.locale,
                notTranslated: page.notTranslated,
                doc: page.solution.doc,
              };
        return Response.json(result);
      }
      if (page.kind !== 'solution') return problemResponse(404, 'not_found');
      const parsed = feedbackInput.safeParse(body);
      if (!parsed.success) return problemResponse(400, 'invalid_input');
      const { counted } = await recordSolutionFeedback(ctx, { number: page.solution.number, outcome: parsed.data.outcome, sessionId: parsed.data.sessionId });
      return Response.json({ counted });
    } catch (error) {
      return hdkProblem(error);
    }
  });
}
