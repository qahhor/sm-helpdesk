import { randomUUID } from 'node:crypto';
import { afterAll, expect, test } from 'vitest';
import { RATE_RULES } from '@/modules/hdc/pref';
import { suggestForClient } from '@/modules/hdk/api/suggest';
import { setEmbedderForTests } from '@/modules/hdk/embeddings';
import { createStubEmbedder, stubVector } from '@/modules/hdk/embeddings/stub';
import { clientCtx, staffWithRole } from '../integration/helpers/auth';
import { seedBulkSolutions, seedBulkTickets } from '../integration/helpers/bulk';
import { pools } from '../integration/helpers/db';
import { type Fixture, seedTwoOrgs } from '../integration/isolation/fixture';

// Замер FR-SOL-14 (план M5, задача 10): 95% ответов подсказки не дольше 500 мс при 50 запросах в секунду на 1000
// решений (3000 строк индекса) и 200 тысячах обращений, векторы заглушки. Не входит в CI: pnpm exec vitest run
// --project perf --silent=false. Пределы частоты на время замера сняты: меряется поиск и запись исхода, а не отказ по пределу.

const RPS = 50;
const SECONDS = 20;
let f: Fixture;
const rules = RATE_RULES as unknown as Record<string, { limit: number }>;
const saved = { user: rules.kbSuggestPerUser!.limit, org: rules.kbSuggestPerOrg!.limit };

// Каждый тест начинается с пустой базы (tests/integration/setup/each.ts): набор заливается внутри теста.
async function seed(): Promise<void> {
  f = await seedTwoOrgs();
  await pools.root.query(`delete from hdk_search_documents`);
  setEmbedderForTests(createStubEmbedder());
  rules.kbSuggestPerUser!.limit = 1_000_000;
  rules.kbSuggestPerOrg!.limit = 1_000_000;
  const staff = await staffWithRole('agent_l1');
  const started = performance.now();
  await seedBulkTickets(200_000, 500, staff.userId);
  await seedBulkSolutions(1000, stubVector);
  console.log(`Набор: 200000 обращений и 1000 решений за ${Math.round((performance.now() - started) / 1000)} с`);
}
afterAll(() => {
  rules.kbSuggestPerUser!.limit = saved.user;
  rules.kbSuggestPerOrg!.limit = saved.org;
  setEmbedderForTests(null);
});

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

const percentile = (sorted: number[], p: number) => sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)]!;

test('FR-SOL-14: p95 подсказки при 50 запросах в секунду', async () => {
  await seed();
  const members = [f.aUser, f.aAdmin, f.bUser, f.bAdmin];
  const contexts = await Promise.all(members.map((m) => clientCtx(m)));
  // Прогрев: планы запросов и соединения пула. Последовательные ответы для сравнения с нагрузкой.
  const sequential: number[] = [];
  for (const q of [...QUERIES, ...QUERIES]) {
    const t0 = performance.now();
    await suggestForClient(contexts[0]!, { text: q, sessionId: randomUUID(), locale: 'ru' });
    sequential.push(performance.now() - t0);
  }
  console.log(`Подсказка по одному запросу: ${sequential.map((ms) => ms.toFixed(0)).join(', ')} мс`);
  const latencies: number[] = [];
  let found = 0;
  const total = RPS * SECONDS;
  const startAt = performance.now();
  await Promise.all(
    Array.from({ length: total }, async (_, i) => {
      const due = startAt + (i * 1000) / RPS;
      await new Promise((resolve) => setTimeout(resolve, Math.max(0, due - performance.now())));
      const t0 = performance.now();
      const result = await suggestForClient(contexts[i % contexts.length]!, { text: `${QUERIES[i % QUERIES.length]} ${i % 13}`, sessionId: randomUUID(), locale: i % 3 === 0 ? 'uz' : 'ru' });
      latencies.push(performance.now() - t0);
      if (result.items.length > 0) found++;
    }),
  );
  const elapsed = (performance.now() - startAt) / 1000;
  latencies.sort((a, b) => a - b);
  const line = `Подсказка: ${total} запросов за ${elapsed.toFixed(1)} с (${(total / elapsed).toFixed(1)} в секунду), с решениями ${found}; p50 ${percentile(latencies, 50).toFixed(0)} мс, p95 ${percentile(latencies, 95).toFixed(0)} мс, p99 ${percentile(latencies, 99).toFixed(0)} мс, максимум ${latencies.at(-1)!.toFixed(0)} мс`;
  console.log(line);
  expect(percentile(latencies, 95)).toBeLessThanOrEqual(500);
}, 900_000);
