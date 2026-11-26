import { expect, test, vi } from 'vitest';
import type { ClientActor, StaffActor } from '@/db/with-actor';
import { BREAKER_OPEN_MS, createBreaker } from '@/modules/hdc/search/breaker';
import { scopeFor } from '@/modules/hdc/search/scoped-key';
import { createStubSearch } from '@/modules/hdc/search/stub';
import { createTypesenseReader } from '@/modules/hdc/search/typesense';
import type { ScopedKey, SearchSpec } from '@/modules/hdc/search/types';

// Клиент поиска Typesense на подменённом fetch (план W6, задача 1, решения 2 и 14): что уходит в запросе, проверка
// ответа схемой, откат при сбое и выключатель. Договор с настоящим сервером проверяет tests/integration/search-contract.

const client: ClientActor = { type: 'client', userId: '00000000-0000-7000-8000-000000000001', orgId: '00000000-0000-7000-8000-0000000000a1', orgRole: 'client_user' };
const staff: StaffActor = { type: 'staff', userId: '00000000-0000-7000-8000-000000000002', staffRole: 'agent_l2' };
const keys = { client: 'client-parent-search-key-0000000001', staff: 'staff-parent-search-key-00000000002' };
const spec: SearchSpec = { collection: 'tickets', q: 'оплата не праходит', queryBy: ['title_ru', 'description_ru'], perPage: 250 };

const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

test('запрос: многократный поиск ключом с областью, без кеша, только id, псевдоним коллекции', async () => {
  const fetch = vi.fn(async () => ok({ results: [{ found: 2, hits: [{ document: { id: 'a' }, text_match: 9, text_match_info: { tokens_matched: 2 } }, { document: { id: 'b' }, text_match: 3 }] }] }));
  const reader = createTypesenseReader({ url: 'http://typesense:8108/', fetch, breaker: createBreaker() });
  const scope = scopeFor(client, 'tickets', keys);
  const res = await reader.searchIds(scope, [spec], { timeoutMs: 100 });
  expect(res).toEqual({ kind: 'ids', results: [{ found: 2, hits: [{ id: 'a', textMatch: 9, tokensMatched: 2 }, { id: 'b', textMatch: 3, tokensMatched: 0 }] }] });
  const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
  expect(url).toBe('http://typesense:8108/multi_search');
  expect((init.headers as Record<string, string>)['x-typesense-api-key']).toBe(scope.value);
  const body = JSON.parse(String(init.body)) as { searches: Record<string, unknown>[] };
  expect(body.searches[0]).toMatchObject({
    collection: 'hub_tickets',
    query_by: 'title_ru,description_ru',
    use_cache: false,
    include_fields: 'id',
    highlight_fields: 'none',
    enable_typos_for_numerical_tokens: false,
    synonym_num_typos: 0,
    demote_synonym_match: true,
    per_page: 250,
  });
  // Организация не приходит из запроса: её несёт только ключ.
  expect(JSON.stringify(body)).not.toContain(client.orgId);
});

test('группы: по первой строке группы', async () => {
  const fetch = vi.fn(async () => ok({ results: [{ found: 2, grouped_hits: [{ group_key: ['t1'], hits: [{ document: { id: 't1_m1' } }] }, { group_key: ['t2'], hits: [{ document: { id: 't2_m5' } }] }] }] }));
  const reader = createTypesenseReader({ url: 'http://typesense:8108', fetch, breaker: createBreaker() });
  const res = await reader.searchIds(scopeFor(staff, 'tickets', keys), [{ ...spec, collection: 'ticket_texts', groupBy: 'ticket_id' }], { timeoutMs: 100 });
  expect(res.kind === 'ids' && res.results[0]!.hits.map((h) => h.id)).toEqual(['t1_m1', 't2_m5']);
});

test('ключ без области и коллекция вне области ключа: ошибка кода, а не откат', async () => {
  const reader = createTypesenseReader({ url: 'http://typesense:8108', fetch: vi.fn(), breaker: createBreaker() });
  const fake = { value: 'x', purpose: 'tickets', collections: ['tickets'], embedded: {} } as unknown as ScopedKey;
  await expect(reader.searchIds(fake, [spec], { timeoutMs: 100 })).rejects.toThrow(/без области/);
  await expect(reader.searchIds(scopeFor(client, 'tickets', keys), [{ ...spec, collection: 'ticket_texts' }], { timeoutMs: 100 })).rejects.toThrow(/вне области/);
  await expect(reader.searchIds(scopeFor(client, 'solutions', keys), [spec], { timeoutMs: 100 })).rejects.toThrow(/вне области/);
});

test('сбой, медленный ответ и мусор дают откат с причиной', async () => {
  const scope = scopeFor(client, 'tickets', keys);
  const cases: [typeof fetch, string][] = [
    [vi.fn(async () => { throw new TypeError('fetch failed'); }) as unknown as typeof fetch, 'unreachable'],
    [vi.fn(async () => new Response('oops', { status: 503 })) as unknown as typeof fetch, 'http_503'],
    [vi.fn(async () => ok({ results: [{ hits: 'nope' }] })) as unknown as typeof fetch, 'invalid_response'],
    [vi.fn(async () => ok({ results: [] })) as unknown as typeof fetch, 'invalid_response'],
    [vi.fn(async () => ok({ results: [{ code: 404, error: 'Not found.' }] })) as unknown as typeof fetch, 'http_404'],
    [
      vi.fn(
        (_url: string, init: RequestInit) =>
          new Promise<Response>((_resolve, reject) => init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))),
      ) as unknown as typeof fetch,
      'timeout',
    ],
  ];
  for (const [fetch, reason] of cases) {
    const reader = createTypesenseReader({ url: 'http://typesense:8108', fetch, breaker: createBreaker() });
    expect(await reader.searchIds(scope, [spec], { timeoutMs: 30 }), reason).toEqual({ kind: 'fallback', reason });
  }
});

test('выключатель: после 5 сбоев за 30 секунд 60 секунд без вызовов', async () => {
  vi.useFakeTimers({ now: new Date('2026-11-26T10:00:00Z') });
  try {
    const fetch = vi.fn(async () => new Response('', { status: 500 }));
    const breaker = createBreaker();
    const reader = createTypesenseReader({ url: 'http://typesense:8108', fetch, breaker });
    const scope = scopeFor(staff, 'tickets', keys, new Date());
    for (let i = 0; i < 5; i++) expect((await reader.searchIds(scope, [spec], { timeoutMs: 50 })).kind).toBe('fallback');
    expect(fetch).toHaveBeenCalledTimes(5);
    expect(await reader.searchIds(scope, [spec], { timeoutMs: 50 })).toEqual({ kind: 'fallback', reason: 'breaker_open' });
    expect(fetch).toHaveBeenCalledTimes(5);
    vi.setSystemTime(Date.now() + BREAKER_OPEN_MS + 1);
    fetch.mockImplementation(async () => ok({ results: [{ found: 0, hits: [] }] }));
    expect(await reader.searchIds(scopeFor(staff, 'tickets', keys, new Date()), [spec], { timeoutMs: 50 })).toEqual({ kind: 'ids', results: [{ found: 0, hits: [] }] });
  } finally {
    vi.useRealTimers();
  }
});

test('заглушка: вложенный фильтр, опечатки, начало слова; "сломать фильтр" отключает только ключ', async () => {
  const stub = createStubSearch();
  const other = '00000000-0000-7000-8000-0000000000b2';
  await stub.upsert('tickets', [
    { id: 't1', version: 1, org_id: client.orgId, author_id: client.userId, visibility: 'org', title_ru: 'Оплата не проходит', number: 1, created_on: 1 },
    { id: 't2', version: 1, org_id: other, author_id: client.userId, visibility: 'org', title_ru: 'Оплата не проходит у нас', number: 2, created_on: 1 },
  ]);
  const scope = scopeFor(client, 'tickets', keys);
  const ids = async (q: string, prefix = false) => {
    const r = await stub.searchIds(scope, [{ collection: 'tickets', q, queryBy: ['title_ru'], perPage: 10, prefix }], { timeoutMs: 10 });
    return r.kind === 'ids' ? r.results[0]!.hits.map((h) => h.id) : r.reason;
  };
  expect(await ids('оплата праходит')).toEqual(['t1']);
  expect(await ids('опла', true)).toEqual(['t1']);
  stub.breakFilter(true);
  expect(await ids('оплата')).toEqual(['t1', 't2']);
  stub.breakFilter(false);
  stub.failWith('timeout');
  expect(await ids('оплата')).toBe('timeout');
  // Старая версия не перезаписывает новую.
  stub.failWith(null);
  await stub.upsert('tickets', [{ id: 't1', version: 5, org_id: client.orgId, author_id: client.userId, visibility: 'org', title_ru: 'Новое', number: 1, created_on: 1 }]);
  await stub.upsert('tickets', [{ id: 't1', version: 4, org_id: client.orgId, author_id: client.userId, visibility: 'org', title_ru: 'Старое', number: 1, created_on: 1 }]);
  expect(stub.documents('tickets').find((d) => d.id === 't1')?.title_ru).toBe('Новое');
});
