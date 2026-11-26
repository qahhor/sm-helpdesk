import { afterEach, beforeEach, expect, test } from 'vitest';
import type { StaffActor } from '@/db/with-actor';
import { createStubSearch, noteIsolationDrop, reconcileCollection, runSearchSync, searchAs, setSearchForTests, setSearchKeysForTests, type StubSearch } from '@/modules/hdc/api';
import { opsAlertText } from '@/modules/hdn/api/ops';
import { collectOpsAlerts, resetSearchHealthForTests } from '@/worker/ops-watch';
import { searchReconcile, setSearchJobWriterForTests } from '@/worker/search-jobs';
import { registerSearch } from '@/worker/search';
import { pools, system } from './helpers/db';
import { seedTwoOrgs } from './isolation/fixture';

// Сверка индекса и сигналы поиска (план W6, задача 4, решения 12 и 14; "На что смотреть", пункт 5): удалённый руками
// и лишний документ чинятся сверкой; больше 0.1% расхождений даёт search_drift; строка очереди старше 5 минут даёт
// search_lag; больше 20 откатов за час даёт search_unavailable; отброшенный у клиента идентификатор даёт
// search_isolation; в тексте сигнала нет адреса и ключа.

registerSearch();
let stub: StubSearch;
const staff: StaffActor = { type: 'staff', userId: '00000000-0000-7000-8000-000000000002', staffRole: 'agent_l1' };
const codes = async () => (await collectOpsAlerts(system, new Date(), { searchWriter: stub })).filter((a) => a.code.startsWith('search_'));

beforeEach(async () => {
  stub = createStubSearch();
  resetSearchHealthForTests();
});
afterEach(() => {
  setSearchForTests(null);
  setSearchKeysForTests(null);
  setSearchJobWriterForTests(undefined);
});

test('сверка: удалённый руками документ возвращается, лишний удаляется', async () => {
  const f = await seedTwoOrgs();
  await runSearchSync(system, stub);
  expect(stub.documents('tickets')).toHaveLength(5);
  await stub.remove('tickets', [f.tickets.aOrg.ticketId]);
  await stub.upsert('tickets', [{ id: '00000000-0000-7000-8000-0000000000ee', org_id: f.orgA.orgId, number: 9, created_on: 1, version: 1 }]);
  const report = await reconcileCollection(system, stub, 'tickets');
  expect(report).toMatchObject({ collection: 'tickets', expected: 5, indexed: 5, missing: 1, stale: 0, extra: 1 });
  expect(stub.documents('tickets').map((d) => d.id)).not.toContain('00000000-0000-7000-8000-0000000000ee');
  await runSearchSync(system, stub);
  expect(stub.documents('tickets').map((d) => d.id)).toContain(f.tickets.aOrg.ticketId);
});

test('ночная сверка: расхождение больше 0.1% поднимает search_drift', async () => {
  const f = await seedTwoOrgs();
  await runSearchSync(system, stub);
  await stub.remove('tickets', [f.tickets.aOrg.ticketId]);
  setSearchJobWriterForTests(stub);
  const reports = await searchReconcile(system);
  expect(reports.find((r) => r.collection === 'tickets')?.drift).toBeCloseTo(0.2);
  expect((await pools.root.query(`select code from hdc_ops_alerts where code = 'search_drift'`)).rows).toHaveLength(1);
});

test('очередь старше 5 минут даёт search_lag', async () => {
  await pools.root.query(`delete from hdc_search_outbox`);
  expect(await codes()).toEqual([]);
  await pools.root.query(`insert into hdc_search_outbox (entity_kind, entity_id, created_on) values ('ticket', '00000000-0000-7000-8000-000000000001', now() - interval '6 minutes')`);
  expect(await codes()).toEqual([{ code: 'search_lag', count: 1, minutes: 6 }]);
});

test('21 откат за час и три проверки здоровья без ответа дают search_unavailable', async () => {
  await pools.root.query(`delete from hdc_search_outbox`);
  setSearchForTests(stub);
  setSearchKeysForTests({ client: 'client-key-0000000001', staff: 'staff-key-00000000002' });
  stub.failWith('timeout');
  const spec = { collection: 'tickets' as const, q: 'оплата', queryBy: ['title_ru'], perPage: 10 };
  for (let i = 0; i < 20; i++) expect((await searchAs(staff, 'tickets', [spec], { timeoutMs: 10 })).kind).toBe('fallback');
  // health() заглушки ложь, пока ответы сломаны: две проверки подряд ещё не сигнал, 20 откатов тоже.
  expect(await codes()).toEqual([]);
  await searchAs(staff, 'tickets', [spec], { timeoutMs: 10 });
  expect(await codes()).toEqual([{ code: 'search_unavailable', count: 21 }]);
  await pools.root.query(`delete from hdc_rate_limits`);
  resetSearchHealthForTests();
  await codes();
  await codes();
  expect(await codes()).toEqual([{ code: 'search_unavailable', count: 0 }]);
  // Отключённый поиск откатом не считается.
  setSearchForTests(null);
  for (let i = 0; i < 25; i++) await searchAs(staff, 'tickets', [spec], { timeoutMs: 10 });
  stub.failWith(null);
  resetSearchHealthForTests();
  expect(await codes()).toEqual([]);
});

test('отброшенный у клиента идентификатор даёт search_isolation; в тексте сигналов нет адреса и ключа', async () => {
  await pools.root.query(`delete from hdc_search_outbox`);
  await noteIsolationDrop('tickets', 2);
  const alerts = await codes();
  expect(alerts).toEqual([{ code: 'search_isolation', count: 1 }]);
  for (const alert of [...alerts, { code: 'search_drift' as const, count: 3, collections: 'tickets' }, { code: 'search_lag' as const, count: 4, minutes: 6 }, { code: 'search_unavailable' as const, count: 21 }]) {
    const text = opsAlertText(alert);
    expect(text).toMatch(/^Smartup Hub: /);
    expect(text).not.toMatch(/http|typesense:8108|key|ключ:/i);
  }
});
