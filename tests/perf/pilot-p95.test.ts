import { randomUUID } from 'node:crypto';
import os from 'node:os';
import { afterAll, expect, test } from 'vitest';
import { loadTicketPage } from '@/app/[locale]/(agent)/agent/tickets/[number]/loader';
import { RATE_RULES } from '@/modules/hdc/pref';
import { listComments } from '@/modules/hdi/api/comments';
import { ideaPage, listIdeas } from '@/modules/hdi/api/board';
import { similarIdeas } from '@/modules/hdi/api/similar';
import { getKnowledgeMetrics } from '@/modules/hdk/api/metrics';
import { suggestForClient } from '@/modules/hdk/api/suggest';
import { setEmbedderForTests } from '@/modules/hdk/embeddings';
import { createStubEmbedder, stubVector } from '@/modules/hdk/embeddings/stub';
import { listTags } from '@/modules/hdr/api';
import { defaultQueueSort, getMetrics, getMetricsBreakdown, getTicket, listQueue, listTickets, QUEUE_KEYS, queueSidebar } from '@/modules/hdt/api';
import { listAssignableStaff, searchOrganizations } from '@/modules/hdu/api';
import { clientCtx, staffCtx } from '../integration/helpers/auth';
import { captureQueries, seedBulkIdeas, seedBulkSolutions, seedBulkTickets, seedBulkVotes } from '../integration/helpers/bulk';
import { pools } from '../integration/helpers/db';
import { type Fixture, seedTwoOrgs } from '../integration/isolation/fixture';

// Замер перед пилотом (план M9-prep, задача 4, решения 7 и 8): миллион обращений в 1000 организаций, 95% закрыты;
// 10 тысяч идей и 500 тысяч голосов; 1000 решений. Время функций, которые вызывают страницы, целиком (запросы и код)
// под ролью hub_app с актором из сессии, то есть с политиками RLS. 40 вызовов после прогрева по одному и 40 вызовов
// восемью одновременными вызывающими; p50 и p95. Подсказка 50 запросов в секунду 20 секунд (FR-SOL-14). Пороги:
// аудит 23.11.2026, раздел 4.3 (страница клиента 300 мс, страница сотрудника 400 мс, запрос очереди 50 мс),
// страница показателей за 90 дней 2 секунды (решение 7). Запросов к базе на страницу до 25. Не входит в CI:
// pnpm exec vitest run --project perf tests/perf/pilot-p95.test.ts --silent=false.

const TICKETS = 1_000_000;
const ORGS = 1000;
const IDEAS = 10_000;
const VOTES = 500_000;
const RUNS = 40;
const PARALLEL = 8;

let f: Fixture;
const rules = RATE_RULES as unknown as Record<string, { limit: number }>;
const savedLimits = Object.fromEntries(Object.entries(rules).map(([key, rule]) => [key, rule.limit]));

afterAll(() => {
  for (const [key, limit] of Object.entries(savedLimits)) rules[key]!.limit = limit;
  setEmbedderForTests(null);
});

const percentile = (sorted: number[], p: number) => sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)]!;

type Row = { name: string; limit: number; p50: number; p95: number; p95Parallel: number; queries: number; pass: boolean };
const rows: Row[] = [];

/** Прогрев, 40 вызовов по одному, 40 вызовов восемью потоками, число запросов к базе за один вызов. */
async function measure(name: string, limit: number, fn: () => Promise<unknown>): Promise<void> {
  for (let i = 0; i < 3; i++) await fn();
  const sequential: number[] = [];
  for (let i = 0; i < RUNS; i++) {
    const t0 = performance.now();
    await fn();
    sequential.push(performance.now() - t0);
  }
  const parallel: number[] = [];
  let next = 0;
  await Promise.all(
    Array.from({ length: PARALLEL }, async () => {
      while (next < RUNS) {
        next++;
        const t0 = performance.now();
        await fn();
        parallel.push(performance.now() - t0);
      }
    }),
  );
  const { queries } = await captureQueries(fn);
  sequential.sort((a, b) => a - b);
  parallel.sort((a, b) => a - b);
  const row = { name, limit, p50: percentile(sequential, 50), p95: percentile(sequential, 95), p95Parallel: percentile(parallel, 95), queries: queries.length, pass: false };
  // Порог держится по одному вызову; восемь одновременных показывают запас, сигнал тревоги аудита вдвое выше цели.
  row.pass = row.p95 <= limit && row.p95Parallel <= limit * 2 && row.queries <= 25;
  rows.push(row);
  console.log(`${name}: p50 ${row.p50.toFixed(1)} мс, p95 ${row.p95.toFixed(1)} мс, p95 при ${PARALLEL} одновременных ${row.p95Parallel.toFixed(1)} мс, запросов ${row.queries}, порог ${limit} мс`);
}

const QUERIES = [
  'при сохранении заказа выходит ошибка, закрыт период',
  'накладная печатается пустым листом',
  'касса зависает при оплате картой',
  'отчёт показывает старые данные за прошлый месяц',
  'не проводится возврат: не хватает остатка',
  'акт сверки не загружается у контрагента',
  'бонус не начисляется по договору',
  'маршрут агента не отправляется на телефон',
];

test('пилот: p95 страниц и запросов на миллионе обращений, 10 тысячах идей и 500 тысячах голосов', async () => {
  f = await seedTwoOrgs();
  for (const rule of Object.values(rules)) rule.limit = 1_000_000_000;
  setEmbedderForTests(createStubEmbedder());
  await pools.root.query(`delete from hdk_search_documents`);

  // --- Набор ---
  let started = performance.now();
  await seedBulkTickets(TICKETS, ORGS, f.l1.userId, { serverId: f.server.serverId, finished: true });
  const ticketsSec = (performance.now() - started) / 1000;
  // Организация А набора изоляции получает около 1000 обращений вразброс по набору: клиент видит столько же, сколько
  // обычная организация. Не одну организацию набора целиком: у seedBulkTickets номер организации зависит от остатка
  // номера, поэтому у каждой организации набора один статус и одна видимость. Обращение с перепиской для страниц обращения.
  const root = await pools.root.connect();
  try {
    await root.query(`set session_replication_role = replica`);
    await root.query(`update hdt_tickets set org_id = $1, author_id = case when number % 3 = 0 then $3::uuid else $4::uuid end where abs(hashtext(ticket_id::text)) % 1000 = $2`, [
      f.orgA.orgId,
      7,
      f.aUser.userId,
      f.aAdmin.userId,
    ]);
    await root.query(`set session_replication_role = origin`);
  } finally {
    await root.query(`set session_replication_role = origin`).catch(() => undefined);
    root.release();
  }
  const page = (await pools.root.query(`select ticket_id, number from hdt_tickets where org_id = $1 and visibility = 'org' and status = 'in_progress' order by number limit 1`, [f.orgA.orgId])).rows[0];
  await pools.root.query(
    `insert into hdt_ticket_messages (org_id, ticket_id, author_id, author_type, body, is_internal, created_on)
     select $1, $2, case when g % 2 = 0 then $3::uuid else $4::uuid end, case when g % 2 = 0 then 'client' else 'staff' end,
            'Сообщение переписки ' || g || '. ' || repeat('Текст. ', 40), g % 7 = 0, now() - ((40 - g) || ' hours')::interval
       from generate_series(1, 30) g`,
    [f.orgA.orgId, page.ticket_id, f.aUser.userId, f.l1.userId],
  );
  await pools.root.query(`analyze hdt_tickets`);

  started = performance.now();
  const orgIds = (await pools.root.query(`select org_id from hdu_organizations where external_company_id like 'bulk-%' order by org_id`)).rows.map((r) => r.org_id as string);
  await seedBulkIdeas(IDEAS, orgIds, stubVector);
  // Клиент А голосует за 300 открытых идей и следит за 20: отметки "мой голос" на доске и на странице.
  await pools.root.query(
    `insert into hdi_votes (org_id, idea_id, user_id) select $1, md5('bulk-idea-' || g)::uuid, $2 from generate_series(15, 6000, 13) g where g % 100 between 15 and 79`,
    [f.orgA.orgId, f.aUser.userId],
  );
  await pools.root.query(`insert into hdi_subscriptions (idea_id, user_id) select md5('bulk-idea-' || g)::uuid, $1 from generate_series(40, 800, 40) g`, [f.aUser.userId]);
  const votes = await seedBulkVotes(VOTES, orgIds);
  const idea = (await pools.root.query(`select idea_id, number from hdi_ideas where status = 'open' order by vote_count desc limit 1`)).rows[0];
  await pools.root.query(
    `insert into hdi_comments (org_id, idea_id, author_id, author_name, body, created_on)
     select $1, $2, $3, 'Клиент', 'Комментарий к идее ' || g, now() - ((60 - g) || ' hours')::interval from generate_series(1, 40) g`,
    [f.orgA.orgId, idea.idea_id, f.aUser.userId],
  );
  await pools.root.query(`update hdi_ideas set comment_count = 40 where idea_id = $1`, [idea.idea_id]);
  const ideasSec = (performance.now() - started) / 1000;

  started = performance.now();
  await seedBulkSolutions(1000, stubVector);
  const solutionsSec = (performance.now() - started) / 1000;
  for (const table of ['hdt_ticket_messages', 'hdi_votes', 'hdi_comments', 'hdi_subscriptions', 'hdi_ideas']) await pools.root.query(`analyze ${table}`);

  const counts = (
    await pools.root.query(
      `select (select count(*) from hdt_tickets)::int as tickets, (select count(*) filter (where status not in ('resolved', 'closed')) from hdt_tickets)::int as open,
              (select count(*) from hdi_ideas)::int as ideas, (select count(*) from hdi_votes)::int as votes, (select count(*) from hdu_organizations)::int as orgs,
              (select count(*) from hdt_tickets where org_id = $1)::int as own`,
      [f.orgA.orgId],
    )
  ).rows[0];
  console.log(
    `Машина: ${os.cpus()[0]?.model} x ${os.cpus().length}, память ${Math.round(os.totalmem() / 2 ** 30)} ГБ; PostgreSQL 18 в контейнере. Набор: ${counts.tickets} обращений (${counts.open} открытых, у организации А ${counts.own}) за ${ticketsSec.toFixed(0)} с; ${counts.orgs} организаций; ${counts.ideas} идей и ${votes} голосов за ${ideasSec.toFixed(0)} с; 1000 решений за ${solutionsSec.toFixed(0)} с`,
  );
  expect(counts.tickets).toBeGreaterThanOrEqual(TICKETS);
  expect(counts.ideas).toBeGreaterThanOrEqual(IDEAS);
  expect(votes).toBeGreaterThanOrEqual(VOTES);

  const client = await clientCtx(f.aUser);
  const l1 = staffCtx(f.l1);
  const care = staffCtx(f.care);

  // --- Кабинет клиента: страница до 300 мс ---
  await measure('Клиент: список обращений', 300, () => listTickets(client, {}));
  await measure('Клиент: поиск по тексту в своей организации', 300, () => listTickets(client, { q: 'нагрузочное обращение 42' }));
  await measure('Клиент: страница обращения (30 сообщений)', 300, () => getTicket(client, String(page.number)));
  for (const tab of ['popular', 'new', 'in_work', 'released'] as const) await measure(`Клиент: доска идей, вкладка ${tab}`, 300, () => listIdeas(client, { tab, locale: 'ru' }));
  await measure('Клиент: доска идей, поиск', 300, () => listIdeas(client, { tab: 'popular', locale: 'ru', q: 'выгрузка' }));
  await measure('Клиент: страница идеи с комментариями', 300, async () => {
    await ideaPage(client, { number: Number(idea.number), locale: 'uz' });
    await listComments(client.actor, { number: Number(idea.number) });
  });
  await measure('Клиент: похожие идеи', 300, () => similarIdeas(client, { text: 'хотим выгрузку заказов в Excel по дате', locale: 'ru' }));

  // --- Рабочее место: запрос очереди до 50 мс, страница до 400 мс ---
  await measure('Сотрудник: боковая панель очередей', 50, () => queueSidebar(l1));
  for (const queue of QUEUE_KEYS) await measure(`Сотрудник: очередь ${queue}`, 50, () => listQueue(l1, { queue, sort: defaultQueueSort(queue), page: 1 }));
  await measure('Сотрудник: очередь all, поиск по тексту', 50, () => listQueue(l1, { queue: 'all', sort: 'updated', q: 'обращение 4242', page: 1 }));
  await measure('Сотрудник: очередь all, поиск по цифрам', 50, () => listQueue(l1, { queue: 'all', sort: 'updated', q: '4242', page: 1 }));
  await measure('Сотрудник: страница очередей целиком', 400, () =>
    Promise.all([listQueue(l1, { queue: 'new', sort: 'sla', page: 1 }), queueSidebar(l1), listTags(l1), listAssignableStaff(l1)]),
  );
  await measure('Сотрудник: страница обращения', 400, () => loadTicketPage(l1, String(page.number), {}, 'ru'));
  await measure('Сотрудник: список организаций', 400, () => searchOrganizations(l1, {}));
  await measure('Сотрудник: поиск организаций', 400, () => searchOrganizations(l1, { query: 'организация 42' }));

  // --- Показатели за 90 дней: 2 секунды (решение 7) ---
  await measure('Сотрудник: страница показателей за 90 дней', 2000, async () => {
    const view = await getMetrics(care, { period: '90' });
    await getKnowledgeMetrics(care, { from: view.period.from, to: view.period.to });
    await Promise.all([
      getMetricsBreakdown(care, { period: '90', by: 'org', pages: 1, locale: 'ru' }),
      getMetricsBreakdown(care, { period: '90', by: 'module', pages: 1, locale: 'ru' }),
    ]);
  });

  // --- Подсказка: 50 запросов в секунду 20 секунд, p95 до 500 мс (FR-SOL-14) ---
  const members = [f.aUser, f.aAdmin, f.bUser, f.bAdmin];
  const contexts = await Promise.all(members.map((m) => clientCtx(m)));
  for (const q of QUERIES) await suggestForClient(contexts[0]!, { text: q, sessionId: randomUUID(), locale: 'ru' });
  const latencies: number[] = [];
  const total = 50 * 20;
  const startAt = performance.now();
  await Promise.all(
    Array.from({ length: total }, async (_, i) => {
      await new Promise((resolve) => setTimeout(resolve, Math.max(0, startAt + i * 20 - performance.now())));
      const t0 = performance.now();
      await suggestForClient(contexts[i % contexts.length]!, { text: `${QUERIES[i % QUERIES.length]} ${i % 13}`, sessionId: randomUUID(), locale: i % 3 === 0 ? 'uz' : 'ru' });
      latencies.push(performance.now() - t0);
    }),
  );
  const elapsed = (performance.now() - startAt) / 1000;
  latencies.sort((a, b) => a - b);
  const suggest = { name: `Подсказка, 50 в секунду (${(total / elapsed).toFixed(1)} в секунду)`, limit: 500, p50: percentile(latencies, 50), p95: percentile(latencies, 95), p95Parallel: percentile(latencies, 95), queries: 0, pass: false };
  suggest.pass = suggest.p95 <= 500;
  rows.push(suggest);

  console.log('\n| Что | p50, мс | p95, мс | p95 при 8 одновременных, мс | Запросов | Порог p95, мс | Итог |\n|---|---|---|---|---|---|---|');
  for (const r of rows) console.log(`| ${r.name} | ${r.p50.toFixed(1)} | ${r.p95.toFixed(1)} | ${r.p95Parallel.toFixed(1)} | ${r.queries || ''} | ${r.limit} | ${r.pass ? 'держится' : 'НЕ держится'} |`);
  expect(rows.filter((r) => !r.pass).map((r) => r.name)).toEqual([]);
}, 3_600_000);
