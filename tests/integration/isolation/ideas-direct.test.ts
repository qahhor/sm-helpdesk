import { expect, test } from 'vitest';
import type { Actor } from '@/db/with-actor';
import { asActor, pools } from '../helpers/db';
import { seedTwoOrgs } from './fixture';
import { seedIdeas } from './ideas-fixture';

// Изоляция идей прямыми запросами под hub_app (ТЗ 15.2, две строки про идеи; план M7, задача 1, решения 2, 7, 8, 10).
// Опубликованные идеи видны клиентам всех организаций, идея на модерации только автору, голос только свой.

const rows = (actor: Actor, sql: string, params: unknown[] = []) => asActor(pools.app, actor, (c) => c.query(sql, params)).then((r) => r.rows);
const ids = (actor: Actor, sql: string, params: unknown[] = []) => rows(actor, sql, params).then((list) => list.map((row) => Object.values(row)[0]));

test('15.2: клиент другой организации видит опубликованную идею, но не идею на модерации ни по номеру, ни по тексту', async () => {
  const f = await seedTwoOrgs();
  const s = await seedIdeas(f);
  const seen = await ids(f.aUser.actor, `select idea_id from hdi_ideas`);
  expect(seen).toContain(s.bOpen.ideaId);
  expect(seen).toContain(s.aPending.ideaId);
  expect(seen).not.toContain(s.bPending.ideaId);
  // По номеру и по тексту чужая идея на модерации тоже не находится.
  expect(await rows(f.aUser.actor, `select 1 from hdi_ideas where number = $1`, [s.bPending.number])).toEqual([]);
  expect(await rows(f.aUser.actor, `select 1 from hdi_idea_translations where title like '%модерации%' and idea_id = $1`, [s.bPending.ideaId])).toEqual([]);
  expect((await rows(f.aUser.actor, `select title from hdi_idea_translations`)).map((r) => r.title)).not.toContain('Секрет Б: идея на модерации');
  // Автор свою идею на модерации видит; сотрудник видит все.
  expect(await ids(f.bUser.actor, `select idea_id from hdi_ideas where idea_id = $1`, [s.bPending.ideaId])).toEqual([s.bPending.ideaId]);
  expect((await ids(f.l1.actor, `select idea_id from hdi_ideas`)).length).toBeGreaterThanOrEqual(8);
});

test('решение 2: отклонённая с модерации видна только автору, после публикации ещё проголосовавшим и подписчикам', async () => {
  const f = await seedTwoOrgs();
  const s = await seedIdeas(f);
  const seenBy = (actor: Actor) => ids(actor, `select idea_id from hdi_ideas where status in ('declined', 'merged')`);
  const aUser = await seenBy(f.aUser.actor);
  const aAdmin = await seenBy(f.aAdmin.actor);
  const bUser = await seenBy(f.bUser.actor);
  // Голосовал aUser, подписан aAdmin: каждый видит свою, но не чужую.
  expect(aUser).toContain(s.bDeclinedVoted.ideaId);
  expect(aUser).not.toContain(s.bDeclinedFollowed.ideaId);
  expect(aAdmin).toContain(s.bDeclinedFollowed.ideaId);
  expect(aAdmin).not.toContain(s.bDeclinedVoted.ideaId);
  // С модерации отклонённая и объединённая не публиковались: только автору.
  for (const seen of [aUser, aAdmin]) {
    expect(seen).not.toContain(s.bDeclinedUnpublished.ideaId);
    expect(seen).not.toContain(s.bMergedUnpublished.ideaId);
    expect(seen).toContain(s.bMergedPublished.ideaId);
  }
  expect(bUser).toEqual(expect.arrayContaining([s.bDeclinedUnpublished.ideaId, s.bMergedUnpublished.ideaId, s.bDeclinedVoted.ideaId]));
  // Текст и вложения отклонённой с модерации тоже закрыты.
  expect(await rows(f.aUser.actor, `select 1 from hdi_idea_translations where idea_id = $1`, [s.bDeclinedUnpublished.ideaId])).toEqual([]);
});

test('15.2: клиент видит только свой голос и свою подписку, разбивки по организациям у него нет', async () => {
  const f = await seedTwoOrgs();
  const s = await seedIdeas(f);
  await pools.root.query(`insert into hdi_votes (org_id, idea_id, user_id) values ($1, $2, $3), ($4, $2, $5), ($4, $2, $6)`, [
    f.orgA.orgId,
    s.bOpen.ideaId,
    f.aUser.userId,
    f.orgB.orgId,
    f.bUser.userId,
    f.bAdmin.userId,
  ]);
  await pools.root.query(`insert into hdi_subscriptions (idea_id, user_id) values ($1, $2), ($1, $3)`, [s.bOpen.ideaId, f.aUser.userId, f.bUser.userId]);
  expect(await rows(f.aUser.actor, `select user_id, org_id from hdi_votes where idea_id = $1`, [s.bOpen.ideaId])).toEqual([{ user_id: f.aUser.userId, org_id: f.orgA.orgId }]);
  expect(await rows(f.aAdmin.actor, `select 1 from hdi_votes where idea_id = $1`, [s.bOpen.ideaId])).toEqual([]);
  expect(await rows(f.aUser.actor, `select user_id from hdi_subscriptions where idea_id = $1`, [s.bOpen.ideaId])).toEqual([{ user_id: f.aUser.userId }]);
  // Счётчики на идее видны всем; разбивку даёт только таблица голосов, а её клиент видит только свою строку.
  expect(await rows(f.aUser.actor, `select vote_count, org_count from hdi_ideas where idea_id = $1`, [s.bOpen.ideaId])).toEqual([{ vote_count: 3, org_count: 2 }]);
  expect((await rows(f.l1.actor, `select org_id, count(*)::int as n from hdi_votes where idea_id = $1 group by org_id order by n`, [s.bOpen.ideaId])).map((r) => r.n)).toEqual([1, 2]);
});

test('решение 8: чужой комментарий на проверке и скрытый не виден, свой виден; комментарии идеи на модерации чужим закрыты', async () => {
  const f = await seedTwoOrgs();
  const s = await seedIdeas(f);
  const add = (idea: string, orgId: string, author: { userId: string; name: string }, status: string, body: string) =>
    pools.root.query(
      `insert into hdi_comments (org_id, idea_id, author_id, author_name, body, status, hide_reason) values ($1, $2, $3, $4, $5, $6, case when $6 = 'hidden' then 'Реклама' end)`,
      [orgId, idea, author.userId, author.name, body, status],
    );
  await add(s.bOpen.ideaId, f.orgB.orgId, f.bUser, 'published', 'Поддерживаю');
  await add(s.bOpen.ideaId, f.orgB.orgId, f.bUser, 'pending', 'Звоните +998 90 123 45 67');
  await add(s.bOpen.ideaId, f.orgB.orgId, f.bUser, 'hidden', 'Купите у нас');
  await add(s.bOpen.ideaId, f.orgA.orgId, f.aUser, 'pending', 'Моя ссылка https://example.com');
  await add(s.bPending.ideaId, f.orgB.orgId, f.bUser, 'published', 'Дополнение автора к идее на модерации');
  const bodies = (await rows(f.aUser.actor, `select body from hdi_comments order by body`)).map((r) => r.body);
  expect(bodies).toEqual(['Моя ссылка https://example.com', 'Поддерживаю']);
  // Автор чужого комментария видит свой на проверке и скрытый; организация автора комментария клиенту не нужна,
  // но строка её несёт: страница её не выводит (решение 7), здесь проверяется только видимость.
  expect((await rows(f.bUser.actor, `select status from hdi_comments where idea_id = $1 order by status`, [s.bOpen.ideaId])).map((r) => r.status)).toEqual([
    'hidden',
    'pending',
    'published',
  ]);
  expect(await rows(f.aUser.actor, `select 1 from hdi_comments where idea_id = $1`, [s.bPending.ideaId])).toEqual([]);
});

test('отборы: клиент видит только завершённые, сотрудник все', async () => {
  const f = await seedTwoOrgs();
  const s = await seedIdeas(f);
  const shortlist = JSON.stringify([{ ideaId: s.bOpen.ideaId, number: s.bOpen.number, voteCount: 1, orgCount: 1, place: 1 }]);
  await pools.root.query(
    `insert into hdi_cycles (cycle, vote_mode, status, shortlist, leader_idea_id, selected_idea_id, decided_on) values
       ('2026-09-01', 'per_user', 'decided', $2, $1, $1, now()), ('2026-10-01', 'per_user', 'lapsed', $2, $1, null, null), ('2026-11-01', 'per_user', 'open', $2, $1, null, null)`,
    [s.bOpen.ideaId, shortlist],
  );
  expect((await rows(f.aUser.actor, `select status from hdi_cycles order by cycle`)).map((r) => r.status)).toEqual(['decided', 'lapsed']);
  expect((await rows(f.l1.actor, `select status from hdi_cycles order by cycle`)).map((r) => r.status)).toEqual(['decided', 'lapsed', 'open']);
});

test('решение 10: вложение чужой идеи видно только чистым и только у опубликованной', async () => {
  const f = await seedTwoOrgs();
  const s = await seedIdeas(f);
  const add = (idea: string | null, status: string, key: string) =>
    pools.root.query(
      `insert into hdi_attachments (org_id, idea_id, uploader_id, storage_key, file_name, mime, size, scan_status) values ($1, $2, $3, $4, 'shot.png', 'image/png', 100, $5)`,
      [f.orgB.orgId, idea, f.bUser.userId, key, status],
    );
  await add(s.bOpen.ideaId, 'clean', 'files/ideas/b/open-clean');
  await add(s.bOpen.ideaId, 'pending', 'quarantine/ideas/open-pending');
  await add(s.bPending.ideaId, 'clean', 'files/ideas/b/pending-clean');
  await add(s.bDeclinedUnpublished.ideaId, 'clean', 'files/ideas/b/declined-clean');
  await add(null, 'pending', 'quarantine/ideas/loose');
  expect((await rows(f.aUser.actor, `select storage_key from hdi_attachments`)).map((r) => r.storage_key)).toEqual(['files/ideas/b/open-clean']);
  expect((await rows(f.bUser.actor, `select storage_key from hdi_attachments order by storage_key`)).length).toBe(5);
});

test('решение 7: снимок названия организации пуст при выключенном показе, база не даёт подставить чужое', async () => {
  const f = await seedTwoOrgs();
  await expect(
    pools.root.query(`insert into hdi_ideas (org_id, author_id, author_name, original_locale, show_org, author_org_name) values ($1, $2, $3, 'ru', false, 'ACME Trade')`, [
      f.orgA.orgId,
      f.aUser.userId,
      f.aUser.name,
    ]),
  ).rejects.toThrow(/hdi_ideas_c5/);
});
