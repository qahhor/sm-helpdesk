import { beforeEach, describe, expect, test } from 'vitest';
import type { ClientActor, StaffActor } from '@/db/with-actor';
import { generateScopedKey, scopeFor } from '@/modules/hdc/search/scoped-key';
import { createTypesenseWriter } from '@/modules/hdc/search/typesense';
import type { SearchSpec } from '@/modules/hdc/search/types';
import { type LiveSearch, liveSearch, master, typesenseSkip, typesenseUrl } from './helpers/search';

// Договор с настоящим Typesense 30.2 (план W6, задачи 1 и 2; "На что смотреть", пункты 1, 2, 6). Образ закреплён
// digest в globalSetup и compose.prod.yaml. Без контейнера набор пропускается с причиной.

const orgA = '00000000-0000-7000-8000-0000000000a1';
const orgB = '00000000-0000-7000-8000-0000000000b2';
const clientA: ClientActor = { type: 'client', userId: '00000000-0000-7000-8000-000000000001', orgId: orgA, orgRole: 'client_user' };
const staff: StaffActor = { type: 'staff', userId: '00000000-0000-7000-8000-000000000002', staffRole: 'agent_l1' };

const ticket = (id: string, org: string, title: string, version = 1) => ({ id, org_id: org, number: 1000 + Number(id.slice(-1)), title_ru: title, title_fold: title, created_on: 1, version });
const ticketSpec = (q: string): SearchSpec => ({ collection: 'tickets', q, queryBy: ['title_ru', 'description_ru'], perPage: 50 });

describe.skipIf(typesenseSkip !== null)(`Typesense 30.2: договор${typesenseSkip ? ` (пропущено: ${typesenseSkip})` : ''}`, () => {
  let live: LiveSearch;
  const keysOf = () => ({ client: live.keys.clientSearch, staff: live.keys.staffSearch });
  const ids = async (actor: ClientActor | StaffActor, specs: SearchSpec[], purpose: 'tickets' | 'solutions' = 'tickets') => {
    const res = await live.reader.searchIds(scopeFor(actor, purpose, keysOf()), specs, { timeoutMs: 2000 });
    if (res.kind !== 'ids') throw new Error(`откат: ${res.reason}`);
    return res.results.map((r) => r.hits.map((h) => h.id));
  };

  beforeEach(async () => {
    live = await liveSearch();
  });

  test('поле с locale uz принимается, стемминг Snowball для uz отклоняется; словарь для uz принимается', async () => {
    const ok = await master('POST', '/collections', { name: 'probe_uz', fields: [{ name: 't', type: 'string', locale: 'uz' }] });
    expect(ok.status).toBe(201);
    const stem = await master('POST', '/collections', { name: 'probe_uz2', fields: [{ name: 't', type: 'string', locale: 'uz', stem: true }] });
    expect(stem.status).toBe(400);
    const schema = (await master('GET', '/collections/hub_solutions')).body as { fields: { name: string; locale: string; stem_dictionary: string }[] };
    expect(schema.fields.find((f) => f.name === 'title_uz')).toMatchObject({ locale: 'uz', stem_dictionary: 'hub_uz_stems' });
    // Узбекская латиница с ʻ остаётся одним словом, кириллица отдельно: свёртку делает портал (поле *_fold).
    await master('POST', '/collections/probe_uz/documents/import?action=upsert', undefined, '{"id":"a","t":"oʻzbek tili"}');
    const hit = (await master('GET', '/collections/probe_uz/documents/search?q=oʻzbek&query_by=t&include_fields=id')).body as { found: number };
    expect(hit.found).toBe(1);
  });

  test('коллекции и псевдонимы созданы; без кеша и только id в каждом ответе', async () => {
    const aliases = (await master('GET', '/aliases')).body as { aliases: { name: string; collection_name: string }[] };
    expect(aliases.aliases.map((a) => `${a.name}->${a.collection_name}`).sort()).toEqual(
      ['hub_ideas->hub_ideas_v1', 'hub_orgs->hub_orgs_v1', 'hub_people->hub_people_v1', 'hub_solutions->hub_solutions_v1', 'hub_ticket_texts->hub_ticket_texts_v1', 'hub_tickets->hub_tickets_v1'],
    );
    // Полей встроенных векторов и моделей нет ни в одной коллекции (решение 6, раздел 14.3).
    for (const a of aliases.aliases) {
      const schema = (await master('GET', `/collections/${a.collection_name}`)).body as { fields: { type: string; embed?: unknown }[] };
      expect(schema.fields.some((f) => f.type.startsWith('float[]') || f.embed !== undefined), a.name).toBe(false);
    }
  });

  test('изоляция: ключ клиента А не находит обращение Б, даже если запрос просит чужую организацию и текст', async () => {
    await live.writer.upsert('tickets', [ticket('t1', orgA, 'Оплата не проходит'), ticket('t2', orgB, 'Оплата не проходит у нас')]);
    expect(await ids(clientA, [ticketSpec('оплата')])).toEqual([['t1']]);
    expect(await ids(clientA, [{ ...ticketSpec('оплата'), filterBy: `org_id:=${orgB}` }])).toEqual([[]]);
    // Поля сверх id запрос не получает: include_fields вложен в ключ.
    const scope = scopeFor(clientA, 'tickets', keysOf());
    const raw = await fetch(`${typesenseUrl}/multi_search`, {
      method: 'POST',
      headers: { 'x-typesense-api-key': scope.value },
      body: JSON.stringify({ searches: [{ collection: 'hub_tickets', q: 'оплата', query_by: 'title_ru', include_fields: 'title_ru,org_id' }] }),
    });
    const body = (await raw.json()) as { results: { hits: { document: Record<string, unknown> }[] }[] };
    expect(body.results[0]!.hits.map((h) => Object.keys(h.document))).toEqual([['id']]);
    // Сотрудник видит все обращения.
    expect((await ids(staff, [ticketSpec('оплата')]))[0]!.sort()).toEqual(['t1', 't2']);
  });

  test('ключи: клиентский не видит переписку, поиск не пишет, просроченный ключ с областью отклоняется', async () => {
    await live.writer.upsert('ticket_texts', [{ id: 't1_m1', ticket_id: 't1', org_id: orgA, is_internal: true, body_ru: 'внутренняя заметка про оплату', version: 1 }]);
    // Ключ клиента с областью на переписку: Typesense отвечает 401, а не данными.
    const forged = generateScopedKey(live.keys.clientSearch, { filter_by: `org_id:=${orgA}`, expires_at: Math.floor(Date.now() / 1000) + 60 });
    const res = await fetch(`${typesenseUrl}/multi_search`, { method: 'POST', headers: { 'x-typesense-api-key': forged }, body: JSON.stringify({ searches: [{ collection: 'hub_ticket_texts', q: 'оплату', query_by: 'body_ru' }] }) });
    const text = await res.text();
    expect(text).not.toContain('t1_m1');
    // Сотрудник находит заметку.
    expect(await ids(staff, [{ collection: 'ticket_texts', q: 'оплату', queryBy: ['body_ru'], perPage: 10, groupBy: 'ticket_id' }])).toEqual([['t1_m1']]);
    // Ключ поиска не пишет.
    const write = await fetch(`${typesenseUrl}/collections/hub_tickets/documents/import?action=upsert`, { method: 'POST', headers: { 'x-typesense-api-key': live.keys.staffSearch }, body: '{"id":"x"}' });
    expect(write.status).toBe(401);
    // Ключ записи не видит коллекций без hub_.
    const other = await fetch(`${typesenseUrl}/collections`, { method: 'POST', headers: { 'x-typesense-api-key': live.keys.write }, body: JSON.stringify({ name: 'other', fields: [{ name: 'a', type: 'string' }] }) });
    expect(other.status).toBe(401);
    // Просроченный ключ с областью.
    const expired = scopeFor(staff, 'tickets', keysOf(), new Date(Date.now() - 120_000));
    expect(await live.reader.searchIds(expired, [ticketSpec('оплата')], { timeoutMs: 2000 })).toEqual({ kind: 'fallback', reason: 'http_401' });
  });

  test('опечатки, свёртка и цифры: "праходит" находит "проходит", 1043 не находит 1042', async () => {
    await live.writer.upsert('tickets', [ticket('t1', orgA, 'Оплата не проходит SUP-1042')]);
    expect(await ids(staff, [ticketSpec('оплата не праходит')])).toEqual([['t1']]);
    expect(await ids(staff, [ticketSpec('1043')])).toEqual([[]]);
    expect(await ids(staff, [ticketSpec('1042')])).toEqual([['t1']]);
  });

  test('курирование: закреплённое внутреннее решение клиенту не приходит (filter_curated_hits вложен в ключ)', async () => {
    const doc = (id: string, audience: string, title: string) => ({ id, article_id: id.split('_')[0]!, locale: 'ru', audience, title_ru: title, version: 1 });
    await live.writer.upsert('solutions', [doc('a1_ru', 'clients', 'Накладная не печатается'), doc('a2_ru', 'internal', 'Внутреннее про накладную')]);
    await live.writer.putCurations([{ id: 'r1', query: 'накладная', match: 'contains', includes: [{ id: 'a2_ru', position: 1 }] }]);
    const spec: SearchSpec = { collection: 'solutions', q: 'накладная', queryBy: ['title_ru'], perPage: 10 };
    expect(await ids(clientA, [spec], 'solutions')).toEqual([['a1_ru']]);
    expect((await ids(staff, [spec], 'solutions'))[0]![0]).toBe('a2_ru');
  });

  test('запись: старшая версия не перезаписывается, удаление по условию, выгрузка версий', async () => {
    await live.writer.upsert('tickets', [ticket('t1', orgA, 'Новая тема', 5)]);
    await live.writer.upsert('tickets', [ticket('t1', orgA, 'Старая тема', 4)]);
    expect(await ids(staff, [ticketSpec('новая')])).toEqual([['t1']]);
    expect(await ids(staff, [ticketSpec('старая')])).toEqual([[]]);
    await live.writer.upsert('tickets', [ticket('t2', orgA, 'Ещё', 1)]);
    expect([...(await live.writer.exportVersions('tickets')).entries()].sort()).toEqual([
      ['t1', 5],
      ['t2', 1],
    ]);
    await live.writer.removeWhere('tickets', 'id:!=[t2]');
    await live.writer.remove('tickets', ['t2']);
    expect((await live.writer.exportVersions('tickets')).size).toBe(0);
    expect(await live.writer.health()).toBe(true);
    expect(await live.writer.memory()).toMatchObject({ usedBytes: expect.any(Number) });
  });

  test('синонимы набором hub_synonyms: "склад" находит "ombor" в поле с языком и в свёрнутом поле', async () => {
    await live.writer.upsert('tickets', [{ ...ticket('t1', orgA, 'x'), title_ru: undefined, title_uz: 'ombor qoldigi', title_fold: 'ombor koldigi' }]);
    await live.writer.putSynonyms([{ id: 's1', synonyms: ['склад', 'ombor', 'warehouse'] }]);
    expect(await ids(staff, [{ collection: 'tickets', q: 'склад', queryBy: ['title_ru', 'title_uz'], perPage: 10 }])).toEqual([['t1']]);
    expect(await ids(staff, [{ collection: 'tickets', q: 'warehouse', queryBy: ['title_uz', 'title_ru'], perPage: 10 }])).toEqual([['t1']]);
    expect(await ids(staff, [{ collection: 'tickets', q: 'sklad', queryBy: ['title_fold'], perPage: 10 }])).toEqual([['t1']]);
  });

  test('ключ записи от других ключей не зависит: неверный ключ даёт ошибку записи с кодом', async () => {
    const bad = createTypesenseWriter({ url: typesenseUrl, key: 'wrong-key-000000000000' });
    await expect(bad.upsert('tickets', [ticket('t1', orgA, 'x')])).rejects.toMatchObject({ code: 'http_401' });
  });
});
