import 'server-only';
import * as z from 'zod';
import { withActor } from '@/db/with-actor';
import { LOCALES } from '@/i18n/locales';
import { consumeRateLimit, rateKey } from '@/modules/hdc/api';
import { RATE_RULES } from '@/modules/hdc/pref';
import type { ClientContext } from '@/modules/hdu/api';
import { ideaTextIds } from '../core/text-search';
import { type BoardCard, boardTx, ideaOfMonthTx, type IdeaView, ideaViewTx, setFollowTx } from '../core/board';
import { ideaByNumberTx } from '../core/ideas';
import { HdiError } from '../error';
import { ideaNumber, parseInput } from '../input';
import { BOARD_QUERY_MAX, BOARD_TABS } from '../pref';
import { voteMode } from './settings';

// Модуль hdi, слой api: доска идей, страница идеи, "Идея месяца" и подписка (ТЗ FR-IDEA-04, 06, 11, 14, 8.3; план
// M7, задача 5, решения 2, 3, 7, 15, 20, 22). Клиент из сессии; номер идеи служит только поиском строки, видимость
// даёт политика. Поиск по доске 30 запросов в минуту (тот же счётчик, что похожие идеи), подписка 60 в час.

export type { BoardCard, IdeaView };

const listInput = z.strictObject({
  tab: z.enum(BOARD_TABS),
  locale: z.enum(LOCALES),
  moduleId: z.uuid().optional(),
  q: z.string().max(BOARD_QUERY_MAX * 4).optional(),
  after: ideaNumber.optional(),
});

export async function listIdeas(ctx: Pick<ClientContext, 'actor'>, input: unknown): Promise<{ items: BoardCard[]; next: number | null }> {
  const data = parseInput(listInput, input);
  const q = data.q?.trim().slice(0, BOARD_QUERY_MAX) || null;
  if (q) {
    const limit = await consumeRateLimit(rateKey('idea-search:user', ctx.actor.userId), RATE_RULES.ideaSearchPerUser);
    if (!limit.allowed) throw new HdiError('rate_limited', { retryAfterSec: limit.retryAfterSec });
  }
  const mode = await voteMode();
  const textIds = q ? await ideaTextIds(ctx.actor, q) : null;
  return withActor(ctx.actor, (tx) => boardTx(tx, { tab: data.tab, locale: data.locale, moduleId: data.moduleId ?? null, q, after: data.after ?? null, textIds }, ctx.actor.userId, mode));
}

const pageInput = z.strictObject({ number: ideaNumber, locale: z.enum(LOCALES) });

/** Страница идеи. Чужая на модерации, отклонённая без голоса и подписки, несуществующая: null. */
export async function ideaPage(ctx: Pick<ClientContext, 'actor'>, input: unknown): Promise<IdeaView | null> {
  const data = parseInput(pageInput, input);
  const mode = await voteMode();
  return withActor(ctx.actor, (tx) => ideaViewTx(tx, data.number, data.locale, ctx.actor.userId, mode));
}

/** "Идея месяца" на главной и на доске: последний отбор с выбором. */
export async function ideaOfMonth(ctx: Pick<ClientContext, 'actor'>, input: unknown): Promise<{ cycle: string; card: BoardCard } | null> {
  const { locale } = parseInput(z.strictObject({ locale: z.enum(LOCALES) }), input);
  const mode = await voteMode();
  return withActor(ctx.actor, (tx) => ideaOfMonthTx(tx, locale, ctx.actor.userId, mode));
}

const followInput = z.strictObject({ number: ideaNumber, follow: z.boolean() });

/**
 * "Следить" и снятие подписки (FR-IDEA-11, решение 15). Подписка открывает отклонённую идею (решение 2), поэтому на
 * отклонённую и объединённую новой подписки нет: voting_closed. Снять подписку можно всегда.
 */
export async function followIdea(ctx: Pick<ClientContext, 'actor'>, input: unknown): Promise<{ subscribed: boolean }> {
  const data = parseInput(followInput, input);
  const limit = await consumeRateLimit(rateKey('idea-follow:user', ctx.actor.userId), RATE_RULES.ideaFollowPerUser);
  if (!limit.allowed) throw new HdiError('rate_limited', { retryAfterSec: limit.retryAfterSec });
  await withActor(ctx.actor, async (tx) => {
    const idea = await ideaByNumberTx(tx, data.number);
    if (!idea) throw new HdiError('not_found');
    if (data.follow && (idea.status === 'declined' || idea.status === 'merged')) throw new HdiError('voting_closed');
    await setFollowTx(tx, idea.ideaId, ctx.actor.userId, data.follow);
  });
  return { subscribed: data.follow };
}
