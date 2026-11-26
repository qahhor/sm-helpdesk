import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { setLogSinkForTests } from '@/lib/log';
import { scopeFor } from '@/modules/hdc/search/scoped-key';
import { createStubSearch, runSearchSync, searchCounters, type SearchIndexWriter, type SearchReader, setSearchForTests, setSearchKeysForTests, type StubSearch } from '@/modules/hdc/api';
import { MemoryJobQueue, setJobQueueForTests } from '@/modules/hdc/testing';
import { listTickets } from '@/modules/hdt/api';
import { createDraftArticle } from '@/modules/hdk/api/articles';
import { solutionEditorState } from '@/modules/hdk/api/editor';
import { publishSolution } from '@/modules/hdk/api/publish';
import { runIndexJob } from '@/modules/hdk/api/search-jobs';
import { searchSolutions } from '@/modules/hdk/api/suggest';
import { setEmbedderForTests } from '@/modules/hdk/embeddings';
import { runIdeaIndexJob } from '@/modules/hdi/api/jobs';
import { similarIdeas } from '@/modules/hdi/api/similar';
import { listIdeas } from '@/modules/hdi/api/board';
import { registerSearch } from '@/worker/search';
import { clientCtx, staffCtx, staffWithRole } from './helpers/auth';
import { pools, system } from './helpers/db';
import { liveSearch, typesenseSkip } from './helpers/search';
import { type Fixture, seedTwoOrgs } from './isolation/fixture';
import { addIdea } from './isolation/ideas-fixture';

// Поиск клиента, подсказка решений и похожие идеи через Typesense (план W6, задачи 6-8, решения 2, 5, 6; "На что
// смотреть", пункт 1): клиент А не получает обращений Б ни при сломанном фильтре заглушки, ни при ключе без фильтра
// на живом Typesense; внутреннее решение не приходит клиенту ни поиском, ни правилом курирования; ответ портала
// не содержит текста из Typesense; при сбое прежний путь.

registerSearch();
let f: Fixture;
const keys = { client: 'client-key-0000000001', staff: 'staff-key-00000000002' };

async function useSearch(reader: SearchReader, writer: SearchIndexWriter, k = keys) {
  setSearchForTests(reader, writer);
  setSearchKeysForTests(k);
  await runSearchSync(system, writer);
}
const clientNumbers = async (q: string) => (await listTickets(await clientCtx(f.aUser), { q })).items.map((t) => t.number).sort();

beforeEach(async () => {
  f = await seedTwoOrgs();
  setJobQueueForTests(new MemoryJobQueue());
  // Заглушка векторов не нужна этим проверкам: без смыслового списка видно, что слова пришли из Typesense.
  setEmbedderForTests({ name: 'stub', dimensions: 1024, embed: async () => { throw new Error('нет векторов'); } });
  await pools.root.query(`update hdt_tickets set title = 'Оплата не проходит в кассе' where ticket_id in ($1, $2)`, [f.tickets.aOrg.ticketId, f.tickets.bOrg.ticketId]);
  await pools.root.query(`delete from hdc_rate_limits`);
});
afterEach(() => {
  setSearchForTests(null);
  setSearchKeysForTests(null);
  setJobQueueForTests(null);
  setEmbedderForTests(null);
  setLogSinkForTests(null);
});

describe('поиск клиента по своим обращениям', () => {
  let stub: StubSearch;
  beforeEach(async () => {
    stub = createStubSearch();
    await useSearch(stub, stub);
  });

  test('опечатка находит своё; чужое не приходит', async () => {
    expect(await clientNumbers('оплата не праходит')).toEqual([f.tickets.aOrg.number]);
  });

  test('сломанный фильтр заглушки: RLS отбрасывает чужое, событие и сигнал изоляции без текста', async () => {
    stub.breakFilter(true);
    const events: string[] = [];
    setLogSinkForTests((_l, event, fields) => events.push(`${event} ${JSON.stringify(fields)}`));
    const found = await listTickets(await clientCtx(f.aUser), { q: 'оплата не праходит' });
    expect(found.items.map((t) => t.number)).toEqual([f.tickets.aOrg.number]);
    expect(JSON.stringify(found)).not.toContain(f.tickets.bOrg.ticketId);
    expect(events.filter((e) => e.startsWith('search.isolation_drop'))).toEqual(['search.isolation_drop {"collection":"tickets","count":1}']);
    expect((await searchCounters(system)).isolationDrops).toBe(1);
  });

  test('личное обращение коллеги, которое RLS не отдаёт, сигналом изоляции не считается', async () => {
    await pools.root.query(`update hdt_tickets set title = 'Закрытая смена кассира' where ticket_id = $1`, [f.tickets.aPrivate.ticketId]);
    await runSearchSync(system, stub);
    expect(await clientNumbers('закрытая смена')).toEqual([]);
    expect((await searchCounters(system)).isolationDrops).toBe(0);
  });

  test('личные обращения коллег не вытесняют свои: 260 чужих личных выше по выдаче, своё находится', async () => {
    await pools.root.query(
      `insert into hdt_tickets (org_id, author_id, type, impact, priority, visibility, title, description, locale, source)
       select $1, $2, 'bug', 'minor', 'p3', 'private', 'Склад остаток ' || g, 'описание', 'ru', 'portal' from generate_series(1, 260) g`,
      [f.orgA.orgId, f.aAdmin.userId],
    );
    const own = (
      await pools.root.query(
        `insert into hdt_tickets (org_id, author_id, type, impact, priority, visibility, title, description, locale, source) values ($1, $2, 'bug', 'minor', 'p3', 'private', 'Склад остаток мой', 'описание', 'ru', 'portal') returning number`,
        [f.orgA.orgId, f.aUser.userId],
      )
    ).rows[0].number;
    await runSearchSync(system, stub);
    const mine = await listTickets(await clientCtx(f.aUser), { q: 'склад остаток' });
    expect(mine.items.map((t) => t.number)).toEqual([Number(own)]);
    // Администратор клиента видит личные обращения своей организации, как и раньше.
    const admin = await listTickets(await clientCtx(f.aAdmin), { q: 'склад остаток' });
    expect(admin.items.length).toBe(20);
    expect((await searchCounters(system)).isolationDrops).toBe(0);
  });

  test('Typesense не отвечает: прежний поиск по части текста', async () => {
    stub.failWith('unreachable');
    expect(await clientNumbers('оплата не проходит')).toEqual([f.tickets.aOrg.number]);
    expect(await clientNumbers('оплата не праходит')).toEqual([]);
  });
});

describe('подсказка решений и идеи', () => {
  let stub: StubSearch;
  let moduleId: string;
  let serial = 0;
  const id = () => `cs${String(++serial).padStart(10, '0')}`;
  const p = (pid: string, text: string) => ({ type: 'paragraph' as const, attrs: { id: pid }, content: [{ type: 'text' as const, text }] });
  const step = (sid: string, text: string) => ({ type: 'step' as const, attrs: { id: sid }, content: [p(`${sid}p`, text)] });
  async function solution(title: string, audience: 'clients' | 'internal') {
    const created = await createDraftArticle(staffCtx(f.l1), { locale: 'ru', title, audience, moduleId, doc: { version: 1, blocks: [p(id(), title), step(id(), 'Откройте настройки кассы')] } });
    const state = await solutionEditorState(staffCtx(f.l1), { number: created.number });
    const l2 = staffCtx(await staffWithRole('agent_l2'));
    expect((await publishSolution(l2, { number: created.number, locale: 'ru', versionId: state!.current.versionId, revision: state!.current.revision, confirmFindings: false })).status).toBe('published');
    await runIndexJob(system, { articleId: created.articleId }).catch(() => undefined);
    return created;
  }
  const suggest = async (actor: Parameters<typeof searchSolutions>[0], text: string, audiences: ('clients' | 'internal')[] = ['clients']) =>
    (await searchSolutions(actor, { text, signature: null, moduleId: null, locale: 'ru', audiences })).items.map((i) => i.number);

  beforeEach(async () => {
    moduleId = (await pools.root.query(`insert into hdr_product_modules (code, name) values ('cs-${Date.now()}-${Math.random()}', '{"ru": "Касса"}') returning module_id`)).rows[0].module_id as string;
    await pools.root.query(`delete from hdc_settings where code = 'kb.allowed_domains'`);
    await pools.root.query(`insert into hdc_settings (code, value) values ('kb.allowed_domains', '["smartup.uz"]')`);
    stub = createStubSearch();
  });

  test('опечатка находит решение; внутреннее клиенту не приходит ни при сломанном фильтре, ни правилом курирования; сотрудник видит', async () => {
    const open = await solution('Касса не печатает чек', 'clients');
    const inner = await solution('Касса не печатает чек внутренняя памятка', 'internal');
    await useSearch(stub, stub);
    const client = (await clientCtx(f.aUser)).actor;
    expect(await suggest(client, 'касса не печатет чек')).toContain(open.number);
    stub.breakFilter(true);
    await stub.putCurations([{ id: 'r1', query: 'касса', match: 'contains', includes: [{ id: `${inner.articleId}_ru`, position: 1 }] }]);
    const found = await suggest(client, 'касса не печатет чек');
    expect(found).toContain(open.number);
    expect(found).not.toContain(inner.number);
    // Отброшенное внутреннее решение без ждущей строки очереди: сигнал изоляции.
    expect((await searchCounters(system)).isolationDrops).toBe(1);
    stub.breakFilter(false);
    const staffFound = await suggest(f.l1.actor, 'касса не печатет чек', ['clients', 'internal']);
    expect(staffFound).toEqual(expect.arrayContaining([open.number, inner.number]));
  });

  test('сбой Typesense: подсказка по прежним спискам SQL', async () => {
    const open = await solution('Касса не печатает чек', 'clients');
    await useSearch(stub, stub);
    stub.failWith('timeout');
    expect(await suggest((await clientCtx(f.aUser)).actor, 'касса не печатает чек')).toContain(open.number);
  });

  test('похожие идеи и поиск по доске: опечатка и другая письменность, скрытых нет, без организации в ответе', async () => {
    const shown = await addIdea(f.orgB.orgId, f.bUser, 'open', { title: 'Печать накладных пачкой за день' });
    const hidden = await addIdea(f.orgB.orgId, f.bUser, 'pending_review', { title: 'Печать накладных пачкой за неделю' });
    for (const ref of [shown, hidden]) await runIdeaIndexJob(system, { ideaId: ref.ideaId }).catch(() => undefined);
    await useSearch(stub, stub);
    stub.breakFilter(true);
    const ctx = await clientCtx(f.aUser);
    const similar = await similarIdeas(ctx, { text: 'печат накладных пачкой', locale: 'ru' });
    expect(similar.map((i) => i.number)).toEqual([shown.number]);
    expect(JSON.stringify(similar)).not.toContain(f.orgB.name);
    const board = await listIdeas(ctx, { tab: 'new', locale: 'ru', q: 'pechat nakladnih' });
    expect(board.items.map((i) => i.number)).toEqual([shown.number]);
  });
});

describe.skipIf(typesenseSkip !== null)(`на Typesense 30.2${typesenseSkip ? ` (пропущено: ${typesenseSkip})` : ''}`, () => {
  test('ключ клиента без фильтра организации: RLS отбрасывает чужое, клиент получает только своё', async () => {
    const live = await liveSearch();
    await useSearch(live.reader, live.writer, { client: live.keys.clientSearch, staff: live.keys.staffSearch });
    expect(await clientNumbers('оплата не праходит')).toEqual([f.tickets.aOrg.number]);
    // Ключ без фильтра организации (ключ сотрудника): Typesense отдаёт и чужое, проверка после отбрасывает.
    const unfiltered: SearchReader = { name: 'typesense', searchIds: (_scope, specs, o) => live.reader.searchIds(scopeFor(f.l1.actor, 'tickets', { client: live.keys.clientSearch, staff: live.keys.staffSearch }), specs, o) };
    setSearchForTests(unfiltered, live.writer);
    const found = await listTickets(await clientCtx(f.aUser), { q: 'оплата не праходит' });
    expect(found.items.map((t) => t.number)).toEqual([f.tickets.aOrg.number]);
    expect((await searchCounters(system)).isolationDrops).toBe(1);
  });
});
