import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { setLogSinkForTests } from '@/lib/log';
import { createStubSearch, runSearchSync, type SearchIndexWriter, type SearchReader, setSearchForTests, setSearchKeysForTests, type StubSearch } from '@/modules/hdc/api';
import { listQueue } from '@/modules/hdt/api/agent';
import { findUserIds, searchOrganizations } from '@/modules/hdu/api';
import { registerSearch } from '@/worker/search';
import { staffCtx } from './helpers/auth';
import { pools, system } from './helpers/db';
import { liveSearch, typesenseSkip } from './helpers/search';
import { type Fixture, seedTwoOrgs } from './isolation/fixture';

// Поиск сотрудника через Typesense (план W6, задача 5, решения 4 и 14; FR-AG-10): опечатка, свёртка письменности,
// переписка и внутренние заметки, ИНН частью; номер и фильтры как раньше; больше 250 даёт подсказку; сбой Typesense
// даёт прежнюю выдачу containsText и событие без текста; адрес почты ищется только в PostgreSQL.

registerSearch();
let f: Fixture;

async function useSearch(reader: SearchReader, writer: SearchIndexWriter, keys = { client: 'client-key-0000000001', staff: 'staff-key-00000000002' }) {
  setSearchForTests(reader, writer);
  setSearchKeysForTests(keys);
  await runSearchSync(system, writer);
}
const numbers = async (q: string) => (await listQueue(staffCtx(f.l1), { queue: 'all', sort: 'updated', q })).items.map((r) => r.number).sort();

beforeEach(async () => {
  f = await seedTwoOrgs();
  await pools.root.query(`update hdt_tickets set title = 'Оплата не проходит в кассе' where ticket_id = $1`, [f.tickets.aOrg.ticketId]);
  await pools.root.query(`update hdu_organizations set inn = '305123456' where org_id = $1`, [f.orgB.orgId]);
});
afterEach(() => {
  setSearchForTests(null);
  setSearchKeysForTests(null);
  setLogSinkForTests(null);
});

describe('на заглушке', () => {
  let stub: StubSearch;
  beforeEach(async () => {
    stub = createStubSearch();
    await useSearch(stub, stub);
  });

  test('опечатка, свёртка и внутренняя заметка находят обращение; номер как раньше', async () => {
    expect(await numbers('оплата не праходит')).toEqual([f.tickets.aOrg.number]);
    expect(await numbers('nakladnaya')).toEqual([f.tickets.bOrg.number]);
    // Внутренняя заметка фикстуры: "Внутренняя заметка сотрудника".
    const note = (await pools.root.query(`select body from hdt_ticket_messages where ticket_id = $1 and is_internal`, [f.tickets.aOrg.ticketId])).rows[0].body as string;
    expect((await numbers(note.split(' ').slice(0, 2).join(' '))).includes(f.tickets.aOrg.number)).toBe(true);
    expect(await numbers(String(f.tickets.bOrg.number))).toEqual([f.tickets.bOrg.number]);
    expect(stub.calls).toBeGreaterThan(0);
  });

  test('фильтр очереди и порядок сохраняются: найденное в Typesense сужается условием очереди', async () => {
    await pools.root.query(`update hdt_tickets set status = 'closed' where ticket_id = $1`, [f.tickets.aOrg.ticketId]);
    expect((await listQueue(staffCtx(f.l1), { queue: 'new', q: 'оплата не проходит' })).items).toEqual([]);
    expect((await listQueue(staffCtx(f.l1), { queue: 'all', sort: 'updated', q: 'оплата не проходит' })).items.map((r) => r.number)).toEqual([f.tickets.aOrg.number]);
  });

  test('больше 250 совпадений: показаны лучшие, подсказка уточнить запрос', async () => {
    await pools.root.query(
      `insert into hdt_tickets (org_id, author_id, type, impact, priority, title, description, locale, source)
       select $1, $2, 'bug', 'minor', 'p3', 'Склад остаток ' || g, 'описание', 'ru', 'portal' from generate_series(1, 251) g`,
      [f.orgA.orgId, f.aUser.userId],
    );
    await runSearchSync(system, stub);
    const list = await listQueue(staffCtx(f.l1), { queue: 'all', sort: 'updated', q: 'склад остаток' });
    expect(list.searchTruncated).toBe(true);
    expect(list.items).toHaveLength(50);
    expect((await listQueue(staffCtx(f.l1), { queue: 'all', sort: 'updated', q: 'оплата' })).searchTruncated).toBe(false);
  });

  test('организация по названию с опечаткой и по ИНН; адрес почты только в PostgreSQL', async () => {
    const orgs = await searchOrganizations(staffCtx(f.l1), { query: 'Glbex' });
    expect(orgs.items.map((o) => o.orgId)).toContain(f.orgB.orgId);
    expect((await searchOrganizations(staffCtx(f.l1), { query: '305123456' })).items.map((o) => o.orgId)).toEqual([f.orgB.orgId]);
    // Адреса в индексе нет, а поиск по подтверждённому адресу работает.
    await pools.root.query(`update auth."user" set email = 'buyer@acme.example', "emailVerified" = true where id = $1`, [f.bUser.userId]);
    expect(await findUserIds(staffCtx(f.l1), 'buyer@acme')).toEqual([f.bUser.userId]);
    expect(JSON.stringify(stub.documents('people'))).not.toContain('buyer@acme');
    expect(await findUserIds(staffCtx(f.l1), f.aUser.name)).toContain(f.aUser.userId);
  });

  test('Typesense не отвечает: прежняя выдача containsText и событие без текста', async () => {
    const before = await numbers('оплата не проходит');
    stub.failWith('timeout');
    const events: string[] = [];
    setLogSinkForTests((_level, event, fields) => events.push(`${event} ${JSON.stringify(fields)}`));
    expect(await numbers('оплата не проходит')).toEqual(before);
    // Опечатки прежний путь не находит: это и есть цена отката.
    expect(await numbers('оплата не праходит')).toEqual([]);
    const fallbacks = events.filter((e) => e.startsWith('search.fallback'));
    expect(fallbacks.length).toBeGreaterThan(0);
    expect(fallbacks.join('\n')).not.toMatch(/оплата|праходит/);
    expect(fallbacks[0]).toContain('"reason":"timeout"');
  });
});

describe.skipIf(typesenseSkip !== null)(`на Typesense 30.2${typesenseSkip ? ` (пропущено: ${typesenseSkip})` : ''}`, () => {
  test('опечатка, свёртка, ИНН частью, заметка; остановленный поиск даёт прежнюю выдачу', async () => {
    const live = await liveSearch();
    await useSearch(live.reader, live.writer, { client: live.keys.clientSearch, staff: live.keys.staffSearch });
    expect(await numbers('оплата не праходит')).toEqual([f.tickets.aOrg.number]);
    expect(await numbers('nakladnaya')).toEqual([f.tickets.bOrg.number]);
    expect((await searchOrganizations(staffCtx(f.l1), { query: '51234' })).items.map((o) => o.orgId)).toEqual([f.orgB.orgId]);
    const note = (await pools.root.query(`select body from hdt_ticket_messages where ticket_id = $1 and is_internal`, [f.tickets.bOrg.ticketId])).rows[0].body as string;
    expect(await numbers(note)).toContain(f.tickets.bOrg.number);
    // Ключ поиска отозван: Typesense отвечает 401, выдача прежняя.
    setSearchKeysForTests({ client: 'wrong-client-key-00001', staff: 'wrong-staff-key-000002' });
    expect(await numbers('оплата не проходит')).toEqual([f.tickets.aOrg.number]);
  });
});
