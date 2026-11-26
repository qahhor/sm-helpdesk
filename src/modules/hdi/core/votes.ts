import 'server-only';
import { and, eq } from 'drizzle-orm';
import type { Tx } from '@/db/client';
import type { ClientActor } from '@/db/with-actor';
import { HdiError } from '../error';
import { VOTING_STATUSES } from '../pref';
import { ideas, ideaVotes } from '../schema';
import { ideaByNumberTx } from './ideas';

// Модуль hdi, слой core: голос и его отзыв (FR-IDEA-04, план M7, решения 3, 4). Голосует только клиент от своего имени
// из своей организации; повторный голос ничего не меняет (ключ таблицы, ON CONFLICT DO NOTHING). Голос вне голосования
// отклоняет и код, и триггер t_hdi_votes_count; счётчик пересчитывает только триггер.

export type VoteState = { voted: boolean; voteCount: number };

async function votable(tx: Tx, actor: ClientActor, number: number) {
  const idea = await ideaByNumberTx(tx, number);
  if (!idea) throw new HdiError('not_found');
  const ownPending = idea.status === 'pending_review' && idea.authorId === actor.userId;
  if (!(VOTING_STATUSES as readonly string[]).includes(idea.status) && !ownPending) throw new HdiError('voting_closed');
  return idea;
}

async function stateOf(tx: Tx, ideaId: string, voted: boolean): Promise<VoteState> {
  const [row] = await tx.select({ voteCount: ideas.voteCount }).from(ideas).where(eq(ideas.ideaId, ideaId)).limit(1);
  return { voted, voteCount: row?.voteCount ?? 0 };
}

export async function voteTx(tx: Tx, actor: ClientActor, number: number): Promise<VoteState> {
  const idea = await votable(tx, actor, number);
  await tx.insert(ideaVotes).values({ orgId: actor.orgId, ideaId: idea.ideaId, userId: actor.userId }).onConflictDoNothing();
  return stateOf(tx, idea.ideaId, true);
}

export async function unvoteTx(tx: Tx, actor: ClientActor, number: number): Promise<VoteState> {
  const idea = await votable(tx, actor, number);
  await tx.delete(ideaVotes).where(and(eq(ideaVotes.ideaId, idea.ideaId), eq(ideaVotes.userId, actor.userId)));
  return stateOf(tx, idea.ideaId, false);
}
