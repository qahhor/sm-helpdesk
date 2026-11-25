import 'server-only';
import { withActor } from '@/db/with-actor';
import { consumeRateLimit, rateKey } from '@/modules/hdc/api';
import { RATE_RULES } from '@/modules/hdc/pref';
import type { ClientContext } from '@/modules/hdu/api';
import { unvoteTx, type VoteState, voteTx } from '../core/votes';
import { HdiError } from '../error';
import { ideaNumber, parseInput } from '../input';
import * as z from 'zod';

// Модуль hdi, слой api: голос и отзыв голоса клиента (FR-IDEA-04, 14.5: 60 в минуту на пользователя; план M7,
// решения 3, 4). Голосующий и его организация только из актора; номер идеи служит поиском строки, права даёт политика.

export type { VoteState };

const voteInput = z.strictObject({ number: ideaNumber });

async function limited(ctx: Pick<ClientContext, 'actor'>): Promise<void> {
  const limit = await consumeRateLimit(rateKey('idea-vote:user', ctx.actor.userId), RATE_RULES.ideaVotePerUser);
  if (!limit.allowed) throw new HdiError('rate_limited', { retryAfterSec: limit.retryAfterSec });
}

export async function voteIdea(ctx: Pick<ClientContext, 'actor'>, input: unknown): Promise<VoteState> {
  const { number } = parseInput(voteInput, input);
  await limited(ctx);
  return withActor(ctx.actor, (tx) => voteTx(tx, ctx.actor, number));
}

export async function unvoteIdea(ctx: Pick<ClientContext, 'actor'>, input: unknown): Promise<VoteState> {
  const { number } = parseInput(voteInput, input);
  await limited(ctx);
  return withActor(ctx.actor, (tx) => unvoteTx(tx, ctx.actor, number));
}
