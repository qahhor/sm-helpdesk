import { Pool } from 'pg';
import { afterAll, expect, test } from 'vitest';
import type { Actor, ClientActor } from '@/db/with-actor';
import { staffWithRole } from '../helpers/auth';
import { appUrl, asActor, pools } from '../helpers/db';
import { seedTwoOrgs } from './fixture';
import { addIdea } from './ideas-fixture';

// Счётчики голосов, организаций и комментариев (план M7, задача 1; на что смотреть при проверке, пункт 2). Их меняют
// только триггеры базы полным пересчётом под блокировкой идеи: параллельные голоса не задваиваются и не теряются,
// после голосов, отзывов, объединения и скрытия счётчик равен count(*).

// Отдельный пул: 20 транзакций должны идти по-настоящему одновременно.
const wide = new Pool({ connectionString: appUrl, max: 20 });
afterAll(() => wide.end());

const vote = (pool: Pool, actor: ClientActor, ideaId: string) =>
  asActor(pool, actor, (c) => c.query(`insert into hdi_votes (org_id, idea_id, user_id) values ($1, $2, $3)`, [actor.orgId, ideaId, actor.userId]));

let serial = 0;

async function clients(orgId: string, count: number, prefix: string): Promise<ClientActor[]> {
  const out: ClientActor[] = [];
  for (let i = 0; i < count; i++) {
    const userId = (
      await pools.root.query(`insert into auth."user" (name, email, "emailVerified") values ($1, $2, true) returning id`, [`${prefix} ${i}`, `u-voter-${(serial += 1)}-${Date.now()}@users.invalid`])
    ).rows[0].id as string;
    await pools.root.query(`insert into hdu_memberships (org_id, user_id, role, source) values ($1, $2, 'client_user', 'smartup')`, [orgId, userId]);
    out.push({ type: 'client', userId, orgId, orgRole: 'client_user' });
  }
  return out;
}

/** Идеи, у которых счётчик расходится с таблицами. */
const drift = () =>
  pools.root
    .query(
      `select i.number, i.vote_count, i.org_count, i.comment_count,
              (select count(*)::int from hdi_votes v where v.idea_id = i.idea_id) as votes,
              (select count(distinct v.org_id)::int from hdi_votes v where v.idea_id = i.idea_id) as orgs,
              (select count(*)::int from hdi_comments c where c.idea_id = i.idea_id and c.status = 'published') as comments
         from hdi_ideas i`,
    )
    .then((r) => r.rows.filter((row) => row.vote_count !== row.votes || row.org_count !== row.orgs || row.comment_count !== row.comments));

const counts = (ideaId: string) =>
  pools.root.query(`select vote_count, org_count, comment_count from hdi_ideas where idea_id = $1`, [ideaId]).then((r) => r.rows[0]);

test('20 одновременных голосов одного пользователя дают один голос', async () => {
  const f = await seedTwoOrgs();
  const idea = await addIdea(f.orgB.orgId, f.bUser, 'open');
  const results = await Promise.allSettled(Array.from({ length: 20 }, () => vote(wide, f.aUser.actor, idea.ideaId)));
  expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  for (const r of results) if (r.status === 'rejected') expect(String(r.reason)).toMatch(/hdi_votes_pk|duplicate key/);
  expect(await counts(idea.ideaId)).toEqual({ vote_count: 1, org_count: 1, comment_count: 0 });
});

test('20 одновременных голосов разных пользователей все учтены; несколько учётных записей одной организации дают одну организацию', async () => {
  const f = await seedTwoOrgs();
  const idea = await addIdea(f.orgB.orgId, f.bUser, 'open');
  const voters = [...(await clients(f.orgA.orgId, 12, 'Склад А')), ...(await clients(f.orgB.orgId, 8, 'Склад Б'))];
  const results = await Promise.allSettled(voters.map((actor) => vote(wide, actor, idea.ideaId)));
  expect(results.filter((r) => r.status === 'rejected')).toEqual([]);
  expect(await counts(idea.ideaId)).toEqual({ vote_count: 20, org_count: 2, comment_count: 0 });
  // Параллельные отзывы тоже не теряются.
  await Promise.all(voters.slice(0, 10).map((actor) => asActor(wide, actor, (c) => c.query(`delete from hdi_votes where idea_id = $1`, [idea.ideaId]))));
  expect(await counts(idea.ideaId)).toEqual({ vote_count: 10, org_count: 2, comment_count: 0 });
  expect(await drift()).toEqual([]);
});

test('сверка: после голосов, отзывов, объединения и скрытия комментариев счётчики равны count(*), голос не задваивается', async () => {
  const f = await seedTwoOrgs();
  const target = await addIdea(f.orgB.orgId, f.bUser, 'open');
  const source = await addIdea(f.orgA.orgId, f.aUser, 'open');
  const extra = await clients(f.orgA.orgId, 3, 'Касса');
  // aUser голосует за обе: после объединения у него один голос за цель.
  for (const actor of [f.aUser.actor, ...extra]) await vote(pools.app, actor, source.ideaId);
  for (const actor of [f.aUser.actor, f.bUser.actor, f.bAdmin.actor]) await vote(pools.app, actor, target.ideaId);
  await asActor(pools.app, f.aAdmin.actor, (c) => c.query(`insert into hdi_votes (org_id, idea_id, user_id) values ($1, $2, $3)`, [f.orgA.orgId, source.ideaId, f.aAdmin.userId]));
  await asActor(pools.app, f.aAdmin.actor, (c) => c.query(`delete from hdi_votes where idea_id = $1`, [source.ideaId]));
  expect(await counts(source.ideaId)).toMatchObject({ vote_count: 4, org_count: 1 });
  // Объединение (решение 6): перенос голосов одним оператором без задвоения, затем удаление голосов источника.
  const product = (await staffWithRole('product')).actor as Actor;
  await asActor(pools.app, product, async (c) => {
    await c.query(`insert into hdi_votes (org_id, idea_id, user_id) select org_id, $2, user_id from hdi_votes where idea_id = $1 on conflict do nothing`, [source.ideaId, target.ideaId]);
    await c.query(`delete from hdi_votes where idea_id = $1`, [source.ideaId]);
    await c.query(`update hdi_ideas set status = 'merged', merged_into_id = $2 where idea_id = $1`, [source.ideaId, target.ideaId]);
  });
  expect(await counts(target.ideaId)).toMatchObject({ vote_count: 6, org_count: 2 });
  expect(await counts(source.ideaId)).toMatchObject({ vote_count: 0, org_count: 0 });
  // Комментарии: опубликованный, на проверке, скрытие и публикация модератором.
  const comment = (actor: ClientActor, name: string, status: string) =>
    asActor(pools.app, actor, (c) =>
      c.query(`insert into hdi_comments (org_id, idea_id, author_id, author_name, body, status) values ($1, $2, $3, $4, 'Текст', $5)`, [actor.orgId, target.ideaId, actor.userId, name, status]),
    );
  await comment(f.aUser.actor, f.aUser.name, 'published');
  await comment(f.bUser.actor, f.bUser.name, 'pending');
  await comment(f.aAdmin.actor, f.aAdmin.name, 'published');
  expect(await counts(target.ideaId)).toMatchObject({ comment_count: 2 });
  await asActor(pools.app, product, (c) => c.query(`update hdi_comments set status = 'published' where author_id = $1`, [f.bUser.userId]));
  await asActor(pools.app, product, (c) => c.query(`update hdi_comments set status = 'hidden', hide_reason = 'Реклама' where author_id = $1`, [f.aAdmin.userId]));
  expect(await counts(target.ideaId)).toMatchObject({ comment_count: 2 });
  expect(await drift()).toEqual([]);
});
