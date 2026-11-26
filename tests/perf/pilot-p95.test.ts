import { randomUUID } from 'node:crypto';
import { afterAll, expect, test } from 'vitest';
import { loadTicketPage } from '@/app/[locale]/(agent)/agent/tickets/[number]/loader';
import { RATE_RULES } from '@/modules/hdc/pref';
import { listComments } from '@/modules/hdi/api/comments';
import { ideaPage, listIdeas } from '@/modules/hdi/api/board';
import { similarIdeas } from '@/modules/hdi/api/similar';
import { getKnowledgeMetrics } from '@/modules/hdk/api/metrics';
import { suggestForClient } from '@/modules/hdk/api/suggest';
import { setEmbedderForTests } from '@/modules/hdk/embeddings';
import { createStubEmbedder } from '@/modules/hdk/embeddings/stub';
import { listTags } from '@/modules/hdr/api';
import { defaultQueueSort, getMetrics, getMetricsBreakdown, getTicket, listQueue, listTickets, QUEUE_KEYS, queueSidebar } from '@/modules/hdt/api';
import { listAssignableStaff, searchOrganizations } from '@/modules/hdu/api';
import { clientCtx, staffCtx } from '../integration/helpers/auth';
import { captureQueries } from '../integration/helpers/bulk';
import { type Fixture, seedTwoOrgs } from '../integration/isolation/fixture';
import { seedPilot } from './pilot-seed';

// Замер перед пилотом (план M9-prep, задача 4, решения 7 и 8): миллион обращений в 1000 организаций, 95% закрыты;
// 10 тысяч идей и 500 тысяч голосов; 1000 решений. Время функций, которые вызывают страницы, целиком (запросы и код)
// под ролью hub_app с актором из сессии, то есть с политиками RLS. 40 вызовов после прогрева по одному и 40 вызовов
// восемью одновременными вызывающими; p50 и p95. Подсказка 50 запросов в секунду 20 секунд (FR-SOL-14). Пороги:
// аудит 23.11.2026, раздел 4.3 (страница клиента 300 мс, страница сотрудника 400 мс, запрос очереди 50 мс),
// страница показателей за 90 дней 2 секунды (решение 7). Запросов к базе на страницу до 25. Не входит в CI:
// pnpm exec vitest run --project perf tests/perf/pilot-p95.test.ts --silent=false.

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

/** Цель p95 по одному вызову и сигнал тревоги аудита (раздел 4.3), с которым сравнивается p95 восьми одновременных. */
type Threshold = { limit: number; alarm: number };
const CLIENT: Threshold = { limit: 300, alarm: 600 };
const STAFF: Threshold = { limit: 400, alarm: 800 };
const QUEUE: Threshold = { limit: 50, alarm: 200 };
// У страницы показателей сигнала тревоги в ТЗ и аудите нет: вдвое выше порога решения 7.
const METRICS: Threshold = { limit: 2000, alarm: 4000 };

type Row = { name: string; limit: number; alarm: number; p50: number; p95: number; p95Parallel: number; queries: number; pass: boolean };
const rows: Row[] = [];

/** Прогрев, 40 вызовов по одному, 40 вызовов восемью потоками, число запросов к базе за один вызов. */
async function measure(name: string, { limit, alarm }: Threshold, fn: () => Promise<unknown>): Promise<void> {
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
  const row = { name, limit, alarm, p50: percentile(sequential, 50), p95: percentile(sequential, 95), p95Parallel: percentile(parallel, 95), queries: queries.length, pass: false };
  // Цель держится по одному вызову; восемь одновременных (машина с 4 ядрами) не выше сигнала тревоги.
  row.pass = row.p95 <= limit && row.p95Parallel <= alarm && row.queries <= 25;
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

  const { page, idea, summary } = await seedPilot(f);
  console.log(summary);

  const client = await clientCtx(f.aUser);
  const l1 = staffCtx(f.l1);
  const care = staffCtx(f.care);

  // --- Кабинет клиента: страница до 300 мс ---
  await measure('Клиент: список обращений', CLIENT, () => listTickets(client, {}));
  await measure('Клиент: поиск по тексту в своей организации', CLIENT, () => listTickets(client, { q: 'нагрузочное обращение 42' }));
  await measure('Клиент: страница обращения (30 сообщений)', CLIENT, () => getTicket(client, String(page.number)));
  for (const tab of ['popular', 'new', 'in_work', 'released'] as const) await measure(`Клиент: доска идей, вкладка ${tab}`, CLIENT, () => listIdeas(client, { tab, locale: 'ru' }));
  await measure('Клиент: доска идей, поиск', CLIENT, () => listIdeas(client, { tab: 'popular', locale: 'ru', q: 'выгрузка' }));
  await measure('Клиент: страница идеи с комментариями', CLIENT, async () => {
    await ideaPage(client, { number: Number(idea.number), locale: 'uz' });
    await listComments(client.actor, { number: Number(idea.number) });
  });
  await measure('Клиент: похожие идеи', CLIENT, () => similarIdeas(client, { text: 'хотим выгрузку заказов в Excel по дате', locale: 'ru' }));

  // --- Рабочее место: запрос очереди до 50 мс, страница до 400 мс ---
  await measure('Сотрудник: боковая панель очередей', QUEUE, () => queueSidebar(l1));
  for (const queue of QUEUE_KEYS) await measure(`Сотрудник: очередь ${queue}`, QUEUE, () => listQueue(l1, { queue, sort: defaultQueueSort(queue), page: 1 }));
  await measure('Сотрудник: очередь all, поиск по тексту', QUEUE, () => listQueue(l1, { queue: 'all', sort: 'updated', q: 'обращение 4242', page: 1 }));
  await measure('Сотрудник: очередь all, поиск по цифрам', QUEUE, () => listQueue(l1, { queue: 'all', sort: 'updated', q: '4242', page: 1 }));
  await measure('Сотрудник: страница очередей целиком', STAFF, () =>
    Promise.all([listQueue(l1, { queue: 'new', sort: 'sla', page: 1 }), queueSidebar(l1), listTags(l1), listAssignableStaff(l1)]),
  );
  await measure('Сотрудник: страница обращения', STAFF, () => loadTicketPage(l1, String(page.number), {}, 'ru'));
  await measure('Сотрудник: список организаций', STAFF, () => searchOrganizations(l1, {}));
  await measure('Сотрудник: поиск организаций', STAFF, () => searchOrganizations(l1, { query: 'организация 42' }));

  // --- Показатели за 90 дней: 2 секунды (решение 7) ---
  await measure('Сотрудник: страница показателей за 90 дней', METRICS, async () => {
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
  const suggest = { name: `Подсказка, 50 в секунду (${(total / elapsed).toFixed(1)} в секунду)`, limit: 500, alarm: 500, p50: percentile(latencies, 50), p95: percentile(latencies, 95), p95Parallel: percentile(latencies, 95), queries: 0, pass: false };
  suggest.pass = suggest.p95 <= 500;
  rows.push(suggest);

  console.log('\n| Что | p50, мс | p95, мс | p95 при 8 одновременных, мс | Запросов | Цель p95 / тревога, мс | Итог |\n|---|---|---|---|---|---|---|');
  for (const r of rows) console.log(`| ${r.name} | ${r.p50.toFixed(1)} | ${r.p95.toFixed(1)} | ${r.p95Parallel.toFixed(1)} | ${r.queries || ''} | ${r.limit} / ${r.alarm} | ${r.pass ? 'держится' : 'НЕ держится'} |`);
  expect(rows.filter((r) => !r.pass).map((r) => r.name)).toEqual([]);
}, 3_600_000);
