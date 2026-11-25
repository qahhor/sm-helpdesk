import { expect, test } from 'vitest';
import { removeIdeaFromIndexTx } from '@/modules/hdk/api/idea-search';
import { runIdeaIndexJob } from '@/modules/hdi/api/jobs';
import { similarIdeas } from '@/modules/hdi/api/similar';
import { voteIdea } from '@/modules/hdi/api/votes';
import { RATE_RULES } from '@/modules/hdc/pref';
import { clientCtx, staffWithRole } from './helpers/auth';
import { withActor } from '@/db/with-actor';
import { asActor, pools, system } from './helpers/db';
import { seedTwoOrgs } from './isolation/fixture';
import { addIdea } from './isolation/ideas-fixture';

// Индекс и похожие идеи при наборе (ТЗ FR-IDEA-02, 10.4; план M7, задача 3, решение 23).

const TITLE = 'Печать накладных пачкой за день';
const QUERY = 'печать накладных пачкой';
const rowsOf = (ideaId: string) =>
  pools.root.query(`select locale, title, audience from hdk_search_documents where kind = 'idea' and ref_id = $1 order by locale`, [ideaId]).then((r) => r.rows);

test('идея на модерации и отклонённая не находятся; после публикации находится, без названия организации в ответе', async () => {
  const f = await seedTwoOrgs();
  const pending = await addIdea(f.orgB.orgId, f.bUser, 'pending_review', { title: TITLE });
  const declined = await addIdea(f.orgB.orgId, f.bUser, 'declined', { title: TITLE, published: true });
  for (const ref of [pending, declined]) {
    await runIdeaIndexJob(system, { ideaId: ref.ideaId });
    expect(await rowsOf(ref.ideaId)).toEqual([]);
  }
  const ctx = await clientCtx(f.aUser);
  expect(await similarIdeas(ctx, { text: QUERY, locale: 'ru' })).toEqual([]);
  // Публикация: показ организации включён, но в индексе и ответе названия нет.
  await pools.root.query(`update hdi_ideas set status = 'open', show_org = true, author_org_name = $2 where idea_id = $1`, [pending.ideaId, f.orgB.name]);
  await runIdeaIndexJob(system, { ideaId: pending.ideaId });
  expect(await rowsOf(pending.ideaId)).toEqual([{ locale: 'ru', title: TITLE, audience: 'clients' }]);
  const found = await similarIdeas(ctx, { text: QUERY, locale: 'ru' });
  expect(found).toEqual([{ number: pending.number, title: TITLE, voteCount: 0, status: 'open', voted: false, isMachine: false }]);
  expect(JSON.stringify(found)).not.toContain(f.orgB.name);
  expect(JSON.stringify(await pools.root.query(`select * from hdk_search_documents where ref_id = $1`, [pending.ideaId]).then((r) => r.rows))).not.toContain(f.orgB.name);
  // Меньше трёх слов: не ищется.
  expect(await similarIdeas(ctx, { text: 'печать накладных', locale: 'ru' })).toEqual([]);
});

test('после перевода идея находится на других языках с заголовком на языке пользователя; не прошедший сверку перевод не индексируется', async () => {
  const f = await seedTwoOrgs();
  const idea = await addIdea(f.orgB.orgId, f.bUser, 'open', { title: TITLE });
  await pools.root.query(
    `insert into hdi_idea_translations (idea_id, locale, title, body, is_machine, status, source_hash) values
       ($1, 'en', 'Batch printing of daily invoices', 'Print all invoices of the day with one button', true, 'machine', repeat('a', 64)),
       ($1, 'uz', 'Kunlik yuk xatlarini bosib chiqarish', 'Bitta tugma bilan', true, 'rejected', repeat('a', 64))`,
    [idea.ideaId],
  );
  await runIdeaIndexJob(system, { ideaId: idea.ideaId });
  expect((await rowsOf(idea.ideaId)).map((r) => r.locale)).toEqual(['en', 'ru']);
  const ctx = await clientCtx(f.aUser);
  expect(await similarIdeas(ctx, { text: 'batch printing invoices', locale: 'en' })).toEqual([
    { number: idea.number, title: 'Batch printing of daily invoices', voteCount: 0, status: 'open', voted: false, isMachine: true },
  ]);
  // На узбекском перевода нет (не прошёл сверку): поиск по-русски даёт оригинал.
  expect((await similarIdeas(ctx, { text: QUERY, locale: 'uz' }))[0]).toMatchObject({ title: TITLE, isMachine: false });
});

test('объединение снимает идею из индекса в той же транзакции модератора; свой голос виден в ответе', async () => {
  const f = await seedTwoOrgs();
  const target = await addIdea(f.orgB.orgId, f.bUser, 'open', { title: 'Печать накладных одной кнопкой' });
  const source = await addIdea(f.orgB.orgId, f.bUser, 'open', { title: TITLE });
  for (const ref of [target, source]) await runIdeaIndexJob(system, { ideaId: ref.ideaId });
  const ctx = await clientCtx(f.aUser);
  await voteIdea(ctx, { number: target.number });
  const product = (await staffWithRole('product')).actor;
  await asActor(pools.app, product, async (c) => {
    await c.query(`update hdi_ideas set status = 'merged', merged_into_id = $2 where idea_id = $1`, [source.ideaId, target.ideaId]);
    await c.query(`delete from hdk_search_documents where kind = 'idea' and ref_id = $1`, [source.ideaId]);
  });
  expect(await rowsOf(source.ideaId)).toEqual([]);
  const found = await similarIdeas(ctx, { text: QUERY, locale: 'ru' });
  expect(found.map((i) => [i.number, i.voted, i.voteCount])).toEqual([[target.number, true, 1]]);
  // Агент первой линии строки идей не снимает (политика: только модератор идей и публикующие решения).
  const l1 = (await staffWithRole('agent_l1')).actor;
  expect(await asActor(pools.app, l1, (c) => c.query(`delete from hdk_search_documents where kind = 'idea'`)).then((r) => r.rowCount)).toBe(0);
});

test('removeIdeaFromIndexTx снимает строки идеи; даже со строкой в индексе объединённая не предлагается', async () => {
  const f = await seedTwoOrgs();
  const idea = await addIdea(f.orgB.orgId, f.bUser, 'open', { title: TITLE });
  await runIdeaIndexJob(system, { ideaId: idea.ideaId });
  const other = await addIdea(f.orgB.orgId, f.bUser, 'open', { title: 'Другая идея' });
  await pools.root.query(`update hdi_ideas set status = 'merged', merged_into_id = $2 where idea_id = $1`, [idea.ideaId, other.ideaId]);
  expect(await similarIdeas(await clientCtx(f.aUser), { text: QUERY, locale: 'ru' })).toEqual([]);
  expect(await withActor(system, (tx) => removeIdeaFromIndexTx(tx, idea.ideaId))).toBe(1);
  expect(await rowsOf(idea.ideaId)).toEqual([]);
});

test('решение 20: похожие идеи не чаще 30 раз в минуту на пользователя', async () => {
  const f = await seedTwoOrgs();
  const ctx = await clientCtx(f.aAdmin);
  for (let i = 0; i < RATE_RULES.ideaSearchPerUser.limit; i++) await similarIdeas(ctx, { text: `${QUERY} ${i}`, locale: 'ru' });
  await expect(similarIdeas(ctx, { text: QUERY, locale: 'ru' })).rejects.toMatchObject({ code: 'rate_limited' });
});
