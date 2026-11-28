import { afterEach, beforeEach, expect, test } from 'vitest';
import { setLogSinkForTests } from '@/lib/log';
import { handleMcpRequest } from '@/modules/hda/api/agent';
import { createMcpClient } from '../helpers/mcp-client';
import { seedAgentToken } from './helpers/agent';
import { analyzeAll, asActor, pools } from './helpers/db';
import { type Fixture, seedTwoOrgs } from './isolation/fixture';
import { expectWithin } from './helpers/timing';

// Планы запросов агента на наборе 10000 обращений (веха M8b, задача 11; решение 31 плана M8b, решение 0039). Обращение
// по номеру берётся индексом, список и поиск укладываются в предел времени запроса агента (5 секунд) с запасом.
// Отдельных индексов для агента не понадобилось.

let f: Fixture;
beforeEach(async () => {
  setLogSinkForTests(() => undefined);
  f = await seedTwoOrgs();
  await pools.root.query(
    `insert into hdt_tickets (org_id, author_id, type, impact, priority, visibility, title, description, locale, source, error_signature)
     select $1, $2, 'bug', 'minor', 'p3', 'org', 'Обращение ' || g, 'Описание ' || g, 'ru', 'portal', case when g % 50 = 0 then repeat('a', 32) end
       from generate_series(1, 10000) g`,
    [f.orgA.orgId, f.aUser.userId],
  );
  await analyzeAll();
});
afterEach(() => setLogSinkForTests(null));

test('обращение по номеру: индекс номера; список, поиск, похожие и риск сроков быстрее секунды на 10000 обращений', async () => {
  const token = await seedAgentToken({ tools: ['get_ticket', 'search_tickets', 'similar_tickets', 'sla_risk_tickets'] });
  const number = (await pools.root.query(`select number from hdt_tickets where org_id = $1 order by number desc limit 1 offset 500`, [f.orgA.orgId])).rows[0].number;
  const plan = (await asActor(pools.app, token.actor, (c) => c.query(`explain select * from hda_agent_tickets where number = $1`, [number]))).rows.map((r) => r['QUERY PLAN']).join('\n');
  expect(plan).toMatch(/Index Scan|Index Only Scan|Bitmap Index Scan/);
  expect(plan).not.toMatch(/Seq Scan on hdt_tickets/);

  const client = createMcpClient({ token: token.value, ip: '10.0.3.12', send: (request) => handleMcpRequest(request) });
  for (const [name, args] of [
    ['get_ticket', { number: Number(number) }],
    ['search_tickets', {}],
    ['search_tickets', { text: 'Обращение 99' }],
    ['search_tickets', { signature: 'a'.repeat(32) }],
    ['similar_tickets', { number: Number(number) }],
    ['sla_risk_tickets', { hours: 72 }],
  ] as const) {
    const started = performance.now();
    const result = await client.callTool(name, args);
    const ms = performance.now() - started;
    expect(result.isError, name).toBeFalsy();
    expectWithin(ms, 1000, `${name} ${JSON.stringify(args)}`);
  }
});
