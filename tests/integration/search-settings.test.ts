import { afterEach, beforeEach, expect, test } from 'vitest';
import { createStubSearch, runSearchSync, type StubSearch } from '@/modules/hdc/api';
import { MemoryJobQueue, setJobQueueForTests } from '@/modules/hdc/testing';
import { cleanupSuggestMisses, maskQuery, suggestMisses } from '@/modules/hdk/api/misses';
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
