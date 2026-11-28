import { afterEach, beforeEach, expect, test } from 'vitest';
import { createStubSearch, prepareSearchIndex, runSearchSync, type SearchIndexWriter, SearchWriteError, type StubSearch } from '@/modules/hdc/api';
import { runSearchReindexJob, searchReconcile, setSearchJobWriterForTests } from '@/worker/search-jobs';
import { MemoryJobQueue, setJobQueueForTests } from '@/modules/hdc/testing';
import { cleanupSuggestMisses, maskQuery, noteSuggestOutcome, suggestMisses } from '@/modules/hdk/api/misses';
import { saveSearchSetting, searchSettingsText } from '@/modules/hdk/api/search-settings';
import { suggestForClient } from '@/modules/hdk/api/suggest';
import { registerSearch } from '@/worker/search';
import { clientCtx, staffCtx, staffWithRole } from './helpers/auth';
import { asActor, pools, system } from './helpers/db';
import { seedTwoOrgs } from './isolation/fixture';

// Настройки поиска администратора (ответ владельца 0070, пункт 4) и тексты пустых подсказок (пункт 5; план W6,
// задача 9, решение 17): запись только администратором со свежим входом и с аудитом, набор доходит до Typesense
// задачей search.sync; пустой запрос подсказки хранится с маской данных, без пользователя и организации, 90 дней, его
// видят администратор и роли публикации решений, клиент и первая линия не видят.

registerSearch();
let stub: StubSearch;
beforeEach(() => {
  stub = createStubSearch();
  setJobQueueForTests(new MemoryJobQueue());
});
afterEach(() => setJobQueueForTests(null));

test('синонимы, словарь и курирование: администратор сохраняет, неверная строка называется, набор уходит в Typesense', async () => {
  const f = await seedTwoOrgs();
  const admin = staffCtx(f.adminStaff);
  await expect(saveSearchSetting(staffCtx(f.l1), { kind: 'synonyms', text: 'склад, ombor' })).rejects.toMatchObject({ code: 'forbidden' });
  expect(await saveSearchSetting(admin, { kind: 'synonyms', text: '# комментарий\nсклад, ombor, warehouse\nнакладная => yuk xati, invoice' })).toEqual({ ok: true });
  expect(await saveSearchSetting(admin, { kind: 'synonyms', text: 'склад, ombor\nодно' })).toEqual({ ok: false, line: 2 });
  // Две стрелки в строке: неверная строка, а не слово с "=>" внутри.
  expect(await saveSearchSetting(admin, { kind: 'synonyms', text: 'склад => ombor => warehouse' })).toEqual({ ok: false, line: 1 });
  expect(await saveSearchSetting(admin, { kind: 'stems', text: "to'lovlar = to'lov\nhisobotlar = hisobot" })).toEqual({ ok: true });
  expect(await saveSearchSetting(admin, { kind: 'curation', text: 'накладная | KB-1042 | 1' })).toEqual({ ok: true });
  expect(await saveSearchSetting(admin, { kind: 'curation', text: 'накладная | 1042 | 99' })).toEqual({ ok: false, line: 1 });
  expect(await searchSettingsText(admin)).toEqual({
    synonyms: 'склад, ombor, warehouse\nнакладная => yuk xati, invoice',
    stems: "to'lovlar = to'lov\nhisobotlar = hisobot",
    curation: 'накладная | 1042 | 1',
  });
  // Аудит: код и число записей.
  const audit = (await pools.root.query(`select diff from hdc_audit_log where action = 'settings.changed' and object_id like 'search.%' order by created_on`)).rows.map((r) => r.diff);
  expect(audit).toEqual([
    { code: 'search.synonyms', items: 2 },
    { code: 'search.uz_stems', items: 2 },
    { code: 'search.curation', items: 1 },
  ]);
  await runSearchSync(system, stub);
  expect(stub.synonyms).toEqual([
    { id: 's2', synonyms: ['склад', 'ombor', 'warehouse'] },
    { id: 's3', root: 'накладная', synonyms: ['yuk xati', 'invoice'] },
  ]);
  // Словарь: как записано и свёрнутые пары.
  expect(stub.stems).toEqual(expect.arrayContaining([{ word: "to'lovlar", root: "to'lov" }, { word: 'tolovlar', root: 'tolov' }, { word: 'hisobotlar', root: 'hisobot' }]));
  // Решения 1042 нет среди опубликованных: правило не уходит.
  expect(stub.curations).toEqual([]);
});

test('пустые подсказки: один клиент за сутки пишет не больше 20 сессий и не вытесняет остальных', async () => {
  const f = await seedTwoOrgs();
  const ctx = await clientCtx(f.aUser);
  for (let i = 0; i < 25; i++)
    await noteSuggestOutcome(ctx.actor, { sessionId: `00000000-0000-7000-8000-${String(i).padStart(12, '0')}`, text: `не открывается отчёт номер ${i}`, locale: 'ru', moduleId: null, found: false });
  // Та же сессия обновляет свою строку и предел не тратит.
  await noteSuggestOutcome(ctx.actor, { sessionId: '00000000-0000-7000-8000-000000000000', text: 'не открывается отчёт уточнение', locale: 'ru', moduleId: null, found: false });
  expect((await pools.root.query(`select count(*)::int as n from hdk_suggest_misses`)).rows[0].n).toBe(20);
  const other = await clientCtx(f.bUser);
  await noteSuggestOutcome(other.actor, { sessionId: '00000000-0000-7000-8000-0000000000ff', text: 'не печатается накладная склада', locale: 'ru', moduleId: null, found: false });
  expect((await pools.root.query(`select count(*)::int as n from hdk_suggest_misses`)).rows[0].n).toBe(21);
});

test('настройки, сохранённые при поиске через PostgreSQL, доходят до Typesense при включении и переиндексации', async () => {
  const f = await seedTwoOrgs();
  const admin = staffCtx(f.adminStaff);
  expect(await saveSearchSetting(admin, { kind: 'synonyms', text: 'склад, ombor' })).toEqual({ ok: true });
  expect(await saveSearchSetting(admin, { kind: 'stems', text: "to'lovlar = to'lov" })).toEqual({ ok: true });
  expect(await saveSearchSetting(admin, { kind: 'curation', text: 'накладная | 1042 | 1' })).toEqual({ ok: true });
  // Без Typesense очередь чистится, но строки настроек остаются.
  await runSearchSync(system, null);
  expect((await pools.root.query(`select entity_id from hdc_search_outbox where entity_kind = 'config' order by entity_id`)).rows.map((r) => r.entity_id)).toEqual(['search.curation', 'search.synonyms', 'search.uz_stems']);
  // Включение: подготовка индекса (как hub search:reindex) применяет все три набора.
  await prepareSearchIndex(system, stub);
  expect(stub.synonyms).toEqual([{ id: 's1', synonyms: ['склад', 'ombor'] }]);
  expect(stub.stems).toEqual(expect.arrayContaining([{ word: "to'lovlar", root: "to'lov" }]));
  expect(stub.configWrites.curations).toBe(1);
});

test('Typesense недоступен дольше повторов: ночная сверка всё равно применяет настройки', async () => {
  const f = await seedTwoOrgs();
  expect(await saveSearchSetting(staffCtx(f.adminStaff), { kind: 'synonyms', text: 'склад, ombor' })).toEqual({ ok: true });
  const broken: SearchIndexWriter = { ...stub, putSynonyms: async () => { throw new SearchWriteError('http_503'); } };
  const start = new Date();
  for (let i = 0; i < 5; i++) await runSearchSync(system, broken, { now: new Date(start.getTime() + i * 3_600_000) });
  expect((await pools.root.query(`select attempts from hdc_search_outbox where entity_kind = 'config'`)).rows).toEqual([{ attempts: 5 }]);
  setSearchJobWriterForTests(stub);
  try {
    await searchReconcile(system);
  } finally {
    setSearchJobWriterForTests(undefined);
  }
  expect(stub.synonyms).toEqual([{ id: 's1', synonyms: ['склад', 'ombor'] }]);
});

test('пустая подсказка: текст с маской, без пользователя и организации; находка удаляет строку; видят публикующие роли', async () => {
  const f = await seedTwoOrgs();
  const ctx = await clientCtx(f.aUser);
  const sessionId = '00000000-0000-7000-8000-00000000c001';
  await suggestForClient(ctx, { text: 'не открывается отчёт по складу, звоните +998 90 123 45 67 или a@b.uz', sessionId, locale: 'ru' });
  const rows = (await pools.root.query(`select * from hdk_suggest_misses`)).rows;
  expect(rows).toHaveLength(1);
  expect(rows[0].query_text).not.toMatch(/998|123 45|a@b\.uz/);
  expect(rows[0].query_text).toContain('отчёт по складу');
  expect(JSON.stringify(rows[0])).not.toContain(f.aUser.userId);
  expect(JSON.stringify(rows[0])).not.toContain(f.orgA.orgId);
  // Клиент и первая линия строк не видят.
  for (const actor of [f.aUser.actor, f.l1.actor]) expect((await asActor(pools.app, actor, (c) => c.query(`select count(*)::int as n from hdk_suggest_misses`))).rows[0].n).toBe(0);
  await expect(suggestMisses(staffCtx(f.l1))).rejects.toMatchObject({ code: 'forbidden' });
  const l2 = staffCtx(await staffWithRole('agent_l2'));
  const summary = await suggestMisses(l2);
  expect(summary.byModule).toEqual([{ moduleId: null, locale: 'ru', count: 1 }]);
  expect(summary.recent.map((r) => r.text)).toEqual([rows[0].query_text]);
  // Через 90 дней строка удаляется.
  expect(await cleanupSuggestMisses(system, new Date(Date.now() + 91 * 86_400_000))).toBe(1);
  expect(maskQuery('ИНН 305123456, сервер acme.smartup.uz')).not.toMatch(/305123456/);
});

test('смена словаря в разборе очереди не перестраивает коллекции сама, а ставит отдельную задачу search.reindex (проверка качества, Q18)', async () => {
  const f = await seedTwoOrgs();
  const admin = staffCtx(f.adminStaff);
  const jobs = new MemoryJobQueue();
  setJobQueueForTests(jobs);
  await prepareSearchIndex(system, stub);
  // Переиндексация начинается с новой версии коллекции: по её созданию видно, шла ли она.
  let versions = 0;
  const createVersion = stub.createVersion.bind(stub);
  stub.createVersion = (...args) => {
    versions += 1;
    return createVersion(...args);
  };
  expect(await saveSearchSetting(admin, { kind: 'stems', text: "to'lovlar = to'lov" })).toEqual({ ok: true });
  jobs.sent.length = 0;
  // Разбор очереди идёт раз в минуту и живёт 120 секунд: полная переиндексация в нём не помещается.
  await runSearchSync(system, stub);
  expect(stub.stems).toEqual(expect.arrayContaining([{ word: "to'lovlar", root: "to'lov" }]));
  expect(versions).toBe(0);
  expect(jobs.sent.filter((j) => j.name === 'search.reindex').map((j) => j.data)).toEqual([{ collections: 'solutions,ideas' }]);
  // Сама задача перестраивает обе коллекции.
  const done = await runSearchReindexJob(system, { collections: 'solutions,ideas' }, stub);
  expect(done.map((r) => r.collection).sort()).toEqual(['ideas', 'solutions']);
  expect(versions).toBe(2);
  // Без смены словаря задачи нет.
  jobs.sent.length = 0;
  expect(await saveSearchSetting(admin, { kind: 'stems', text: "to'lovlar = to'lov" })).toEqual({ ok: true });
  await runSearchSync(system, stub);
  expect(jobs.sent.filter((j) => j.name === 'search.reindex')).toEqual([]);
});
