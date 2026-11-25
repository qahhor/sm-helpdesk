import 'server-only';
import { and, eq, sql } from 'drizzle-orm';
import * as z from 'zod';
import type { SystemActor } from '@/db/with-actor';
import { withActor } from '@/db/with-actor';
import { LOCALES, type Locale } from '@/i18n/locales';
import { consumeRateLimit, problemResponse, rateKey } from '@/modules/hdc/api';
import { RATE_RULES } from '@/modules/hdc/pref';
import type { ClientContext } from '@/modules/hdu/api/orgs';
import { fileByIdTx } from '../core/editor';
import { wasArchivedForClientsTx } from '../core/publish';
import { HdkError } from '../error';
import { kbArticles, kbDeflectionEvents, kbPublished } from '../schema';
import { parseSolutionRef } from '../slug';
import { type PublishedSolution, readPublishedSolution } from './articles';
import { streamFileResponse } from './files';

// Модуль hdk, слой api: страница решения для вошедшего клиента (план M5, задача 4; FR-SOL-15, 17; решения 9, 11, 12,
// 16). Текст только из hdk_published от имени клиента (политика отдаёт только audience = clients): черновик, версия,
// перевод в работе и решение "только через сотрудника" для клиента не существуют. Изображение отдаётся, только если
// оно упомянуто в видимой клиенту строке копии этого решения.
//
// Клиент не читает hdk_articles, hdk_article_files и hdk_deflection_events: страница "больше не действует", выдача
// файла после проверки копии, счётчики "помогло" и исход подсказки идут от имени системы.

const SYSTEM: SystemActor = { type: 'system', job: 'kb.client' };

/** Порядок языков, если решения нет на языке страницы (FR-SOL-10): узбекский, русский, английский. */
const FALLBACK: readonly Locale[] = ['uz', 'ru', 'en'];

export type ClientSolutionPage =
  | { kind: 'solution'; solution: PublishedSolution; requestedLocale: Locale; notTranslated: boolean; canonicalRef: string }
  | { kind: 'archived'; number: number }
  | null;

/** Решение по адресу /help/a/{ref} на языке страницы или по цепочке языков; архивное: страница "больше не действует". */
export async function clientSolutionPage(ctx: ClientContext, input: { ref: string; locale: string }): Promise<ClientSolutionPage> {
  const ref = parseSolutionRef(input.ref);
  const requested = z.enum(LOCALES).safeParse(input.locale);
  if (!ref || !requested.success) return null;
  for (const locale of [requested.data, ...FALLBACK.filter((l) => l !== requested.data)]) {
    const solution = await readPublishedSolution(ctx, { number: ref.number, locale });
    if (solution)
      return { kind: 'solution', solution, requestedLocale: requested.data, notTranslated: locale !== requested.data, canonicalRef: `${solution.number}-${solution.slug}` };
  }
  return (await withActor(SYSTEM, (tx) => wasArchivedForClientsTx(tx, ref.number))) ? { kind: 'archived', number: ref.number } : null;
}

/**
 * GET /help/a/{ref}/files/{id}. Клиент без входа: 401. Файл упомянут в видимой клиенту строке копии этого решения
 * (политика RLS, решение 16) и проверен антивирусом: поток из хранилища с типом от портала и nosniff. Иначе 404:
 * черновой файл, файл другого решения и файл внутреннего решения неразличимы.
 */
export async function clientSolutionFileResponse(ctx: ClientContext | null, input: { ref: string; fileId: string }): Promise<Response> {
  if (!ctx) return problemResponse(401, 'unauthenticated');
  const ref = parseSolutionRef(input.ref);
  const fileId = z.uuid().safeParse(input.fileId);
  if (!ref || !fileId.success) return problemResponse(404, 'not_found');
  const id = fileId.data.toLowerCase();
  const [published] = await withActor(ctx.actor, (tx) =>
    tx
      .select({ articleId: kbPublished.articleId })
      .from(kbPublished)
      .where(and(eq(kbPublished.articleNumber, ref.number), sql`${id}::uuid = any(${kbPublished.fileIds})`))
      .limit(1),
  );
  if (!published) return problemResponse(404, 'not_found');
  const file = await withActor(SYSTEM, (tx) => fileByIdTx(tx, id));
  if (!file || file.articleId !== published.articleId) return problemResponse(404, 'not_found');
  return streamFileResponse(file);
}

const feedbackInput = z.strictObject({
  number: z.coerce.number().int().positive(),
  outcome: z.enum(['helped', 'not_helped']),
  sessionId: z.uuid().optional(),
});

/**
 * "Помогло" или "Не помогло" на странице решения (решение 12): счётчик решения пишет система, один голос в сутки на
 * решение и пользователя. Пришли с подсказки (сессия формы): исход этой сессии обновляется, если решение было в
 * показанных. Без сессии строка исходов не создаётся: она про показы подсказки, а не про чтение страницы.
 */
export async function recordSolutionFeedback(ctx: ClientContext, input: unknown): Promise<{ counted: boolean }> {
  const parsed = feedbackInput.safeParse(input);
  if (!parsed.success) throw new HdkError('invalid_input');
  const data = parsed.data;
  const perUser = await consumeRateLimit(rateKey('kb-feedback:user', ctx.actor.userId), RATE_RULES.kbFeedbackPerUser);
  if (!perUser.allowed) throw new HdkError('rate_limited', { retryAfterSec: perUser.retryAfterSec });
  // Решение видно клиенту: иначе голосовать не за что (внутреннее, черновик и архивное неразличимы).
  const [visible] = await withActor(ctx.actor, (tx) =>
    tx.select({ articleId: kbPublished.articleId }).from(kbPublished).where(eq(kbPublished.articleNumber, data.number)).limit(1),
  );
  if (!visible) throw new HdkError('not_found');
  const once = await consumeRateLimit(rateKey('kb-feedback:vote', `${ctx.actor.userId}:${data.number}`), RATE_RULES.kbFeedbackOnce);
  await withActor(SYSTEM, async (tx) => {
    if (once.allowed) {
      const column = data.outcome === 'helped' ? kbArticles.helpedCount : kbArticles.notHelpedCount;
      await tx
        .update(kbArticles)
        .set(data.outcome === 'helped' ? { helpedCount: sql`${column} + 1` } : { notHelpedCount: sql`${column} + 1` })
        .where(eq(kbArticles.articleId, visible.articleId));
    }
    if (data.sessionId)
      await tx
        .update(kbDeflectionEvents)
        .set({ outcome: data.outcome })
        .where(
          and(
            eq(kbDeflectionEvents.sessionId, data.sessionId),
            eq(kbDeflectionEvents.userId, ctx.actor.userId),
            eq(kbDeflectionEvents.orgId, ctx.actor.orgId),
            sql`${visible.articleId}::uuid = any(${kbDeflectionEvents.shownArticleIds})`,
            sql`${kbDeflectionEvents.outcome} <> 'ticket_created'`,
          ),
        );
  });
  return { counted: once.allowed };
}
