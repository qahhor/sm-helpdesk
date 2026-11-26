import { expect, test } from 'vitest';
import { unvoteIdea, voteIdea } from '@/modules/hdi/api/votes';
import { clientCtx } from './helpers/auth';
import { pools } from './helpers/db';
import { seedTwoOrgs } from './isolation/fixture';
import { addIdea } from './isolation/ideas-fixture';

// Голос одного клиента из двух вкладок одновременно (сценарий 7, ideas-scenario.spec.ts:95; разбор подготовки M9,
// задача 10): база принимает один голос, ни один запрос не падает, счётчик равен числу строк голосов.

const count = async (ideaId: string) =>
  (await pools.root.query(`select (select count(*)::int from hdi_votes where idea_id = $1) as rows, (select vote_count from hdi_ideas where idea_id = $1) as counter`, [ideaId])).rows[0];

test('два одновременных голоса и отзыв с голосом одного человека сходятся к одному состоянию без ошибок', async () => {
  const f = await seedTwoOrgs();
  const idea = await addIdea(f.orgB.orgId, f.bUser, 'open', { title: 'Две вкладки' });
  const a = await clientCtx(f.aUser);
  const b = await clientCtx(f.bUser);
  for (let round = 0; round < 10; round++) {
    await Promise.all([voteIdea(a, { number: idea.number }), voteIdea(a, { number: idea.number }), voteIdea(b, { number: idea.number })]);
    expect(await count(idea.ideaId), `раунд ${round}: два голоса`).toEqual({ rows: 2, counter: 2 });
    await unvoteIdea(a, { number: idea.number });
    await unvoteIdea(b, { number: idea.number });
    expect(await count(idea.ideaId)).toEqual({ rows: 0, counter: 0 });
  }
});
