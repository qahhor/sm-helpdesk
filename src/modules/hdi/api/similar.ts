import 'server-only';
import { withActor } from '@/db/with-actor';
import type { Locale } from '@/i18n/locales';
import { consumeRateLimit, problemResponse, rateKey } from '@/modules/hdc/api';
import { RATE_RULES } from '@/modules/hdc/pref';
import { searchIdeaDocuments } from '@/modules/hdk/api/idea-search';
import { type ClientContext, currentClient } from '@/modules/hdu/api';
import { ideaCardsTx } from '../core/cards';
import { HdiError, isHdiError } from '../error';
import { parseInput, similarInput } from '../input';
import { type IdeaStatus, SIMILAR_LIMIT, SIMILAR_MIN_WORDS, SIMILAR_QUERY_MAX } from '../pref';
import { wordCount } from '../util';

// Модуль hdi, слой api: похожие идеи при наборе (ТЗ FR-IDEA-02; план M7, задача 3, решения 20, 23). Поиск по общему
// индексу тем же гибридным запросом, что подсказка решений, от имени клиента: политика индекса отдаёт только строки
// для клиентов, политика идей только видимые идеи. Ответ: номер, заголовок на языке пользователя, голоса, статус и
// свой голос. Ни автора, ни организации в ответе нет. 30 запросов в минуту на пользователя.

export type SimilarIdea = { number: number; title: string; voteCount: number; status: IdeaStatus; voted: boolean; isMachine: boolean };

/** Объединённые и отклонённые не предлагаются, даже если строка индекса ещё не снята. */
const HIDDEN: IdeaStatus[] = ['pending_review', 'declined', 'merged'];

export async function similarIdeas(ctx: Pick<ClientContext, 'actor'>, input: unknown): Promise<SimilarIdea[]> {
  const data = parseInput(similarInput, input);
  const text = data.text.trim().slice(0, SIMILAR_QUERY_MAX);
  if (wordCount(text) < SIMILAR_MIN_WORDS) return [];
  const limit = await consumeRateLimit(rateKey('idea-search:user', ctx.actor.userId), RATE_RULES.ideaSearchPerUser);
  if (!limit.allowed) throw new HdiError('rate_limited', { retryAfterSec: limit.retryAfterSec });
  const hits = await searchIdeaDocuments(ctx.actor, { text, locale: data.locale as Locale, limit: SIMILAR_LIMIT * 2 });
  const cards = await withActor(ctx.actor, (tx) => ideaCardsTx(tx, hits.map((hit) => hit.ideaId), { locale: data.locale, userId: ctx.actor.userId, exclude: HIDDEN }));
  return cards.slice(0, SIMILAR_LIMIT).map((card) => ({ number: card.number, title: card.title, voteCount: card.voteCount, status: card.status, voted: card.voted, isMachine: card.isMachine }));
}

/** GET /api/ideas/similar?text=...&locale=ru: сессия клиента, Zod, предел; ответ без кеша. */
export async function handleSimilarRequest(request: Request): Promise<Response> {
  if (request.headers.has('authorization')) return problemResponse(403, 'forbidden');
  const client = await currentClient();
  if (!client) return problemResponse(401, 'unauthenticated');
  const url = new URL(request.url);
  try {
    const items = await similarIdeas(client, { text: url.searchParams.get('text') ?? '', locale: url.searchParams.get('locale') ?? '' });
    return Response.json({ items }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    if (!isHdiError(error)) throw error;
    const headers: Record<string, string> = error.retryAfterSec ? { 'Retry-After': String(error.retryAfterSec) } : {};
    return problemResponse(error.code === 'rate_limited' ? 429 : 400, error.code, headers);
  }
}
