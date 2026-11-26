import { pools } from '../helpers/db';
import type { Fixture } from './fixture';

// Идеи для проверок изоляции (план M7, задача 1). Строки создаются под суперпользователем: ошибка в сервисе не должна
// прятать ошибку в политике. Статусы ставятся сразу (триггер без актора пропускает), дата публикации по решению 2.

export type IdeaRef = { ideaId: string; number: number };

export async function addIdea(
  orgId: string,
  author: { userId: string; name: string },
  status: string,
  opts: { published?: boolean; title?: string; mergedInto?: string; reason?: string; locale?: string } = {},
): Promise<IdeaRef> {
  const published = opts.published ?? status !== 'pending_review';
  const r = await pools.root.query(
    `insert into hdi_ideas (org_id, author_id, author_name, original_locale, status, published_on, merged_into_id, decline_reason, released_in, released_on)
     values ($1, $2, $3, $4, $5, case when $6 then now() end, $7, $8, case when $5 = 'released' then '5.11' end, case when $5 = 'released' then current_date end)
     returning idea_id, number`,
    [orgId, author.userId, author.name, opts.locale ?? 'ru', status, published, opts.mergedInto ?? null, status === 'declined' ? (opts.reason ?? 'Не подходит') : null],
  );
  const ideaId = r.rows[0].idea_id as string;
  const title = opts.title ?? `Идея ${status}`;
  await pools.root.query(`insert into hdi_idea_translations (idea_id, locale, title, body, source_hash) values ($1, $2, $3, $3 || ': описание', repeat('a', 64))`, [
    ideaId,
    opts.locale ?? 'ru',
    title,
  ]);
  return { ideaId, number: Number(r.rows[0].number) };
}

export type IdeaSet = {
  /** Своя идея aUser на модерации. */
  aPending: IdeaRef;
  /** Идея bUser на модерации: aUser её не видит. */
  bPending: IdeaRef;
  /** Опубликованная идея bUser: видна всем клиентам. */
  bOpen: IdeaRef;
  /** Отклонена с модерации, не публиковалась: видит только автор. */
  bDeclinedUnpublished: IdeaRef;
  /** Отклонена после публикации; за неё голосовал aUser: он её видит, aAdmin нет (решение 2). */
  bDeclinedVoted: IdeaRef;
  /** Отклонена после публикации; на неё подписан aAdmin. */
  bDeclinedFollowed: IdeaRef;
  /** Объединена с bOpen прямо с модерации (не публиковалась): видит только автор. */
  bMergedUnpublished: IdeaRef;
  /** Объединена с bOpen после публикации: видна всем. */
  bMergedPublished: IdeaRef;
};

export async function seedIdeas(f: Fixture): Promise<IdeaSet> {
  const bOpen = await addIdea(f.orgB.orgId, f.bUser, 'open', { title: 'Секрет Б: опубликованная идея' });
  const bDeclinedVoted = await addIdea(f.orgB.orgId, f.bUser, 'open', { title: 'Отклонена после публикации' });
  const bDeclinedFollowed = await addIdea(f.orgB.orgId, f.bUser, 'open', { title: 'Отклонена, есть подписчик' });
  await pools.root.query(`insert into hdi_votes (org_id, idea_id, user_id) values ($1, $2, $3)`, [f.orgA.orgId, bDeclinedVoted.ideaId, f.aUser.userId]);
  await pools.root.query(`insert into hdi_subscriptions (idea_id, user_id) values ($1, $2)`, [bDeclinedFollowed.ideaId, f.aAdmin.userId]);
  for (const ref of [bDeclinedVoted, bDeclinedFollowed])
    await pools.root.query(`update hdi_ideas set status = 'declined', decline_reason = 'Уже есть в плане' where idea_id = $1`, [ref.ideaId]);
  return {
    aPending: await addIdea(f.orgA.orgId, f.aUser, 'pending_review', { title: 'Своя идея на модерации' }),
    bPending: await addIdea(f.orgB.orgId, f.bUser, 'pending_review', { title: 'Секрет Б: идея на модерации' }),
    bOpen,
    bDeclinedUnpublished: await addIdea(f.orgB.orgId, f.bUser, 'declined', { published: false, title: 'Секрет Б: отклонена с модерации' }),
    bDeclinedVoted,
    bDeclinedFollowed,
    bMergedUnpublished: await addIdea(f.orgB.orgId, f.bUser, 'merged', { published: false, mergedInto: bOpen.ideaId, title: 'Секрет Б: объединена с модерации' }),
    bMergedPublished: await addIdea(f.orgB.orgId, f.bUser, 'merged', { mergedInto: bOpen.ideaId, title: 'Объединена после публикации' }),
  };
}
