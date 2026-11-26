import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { sql } from 'drizzle-orm';
import { withActor } from '@/db/with-actor';
import { setLogSinkForTests } from '@/lib/log';
import { createStubSearch, reindexCollection, runSearchSync, type SearchIndexWriter, SearchWriteError, type StubSearch } from '@/modules/hdc/api';
import { createDraftArticle } from '@/modules/hdk/api/articles';
import { solutionEditorState } from '@/modules/hdk/api/editor';
import { archiveSolution, publishSolution } from '@/modules/hdk/api/publish';
import { MemoryJobQueue, setJobQueueForTests } from '@/modules/hdc/testing';
import { registerSearch } from '@/worker/search';
import { staffCtx, staffWithRole } from './helpers/auth';
import { asActor, pools, system } from './helpers/db';
import { liveSearch, typesenseSkip } from './helpers/search';
import { type Fixture, seedTwoOrgs } from './isolation/fixture';
import { addIdea } from './isolation/ideas-fixture';

// Индекс поиска и синхронизация (план W6, задача 3, решения 1, 10, 11, 12; "На что смотреть", пункты 3 и 5): строка
// очереди пишется в транзакции изменения, откат её не оставляет, неиндексируемая колонка её не пишет; клиент очередь
// не читает; повторы схлопываются; состав документов без заметок клиента, адресов, имён авторов и черновиков;
// архив, сужение аудитории, отклонение и объединение убирают документ; сбой оставляет строку с кодом.

registerSearch();
let f: Fixture;
let stub: StubSearch;
const queue = () => pools.root.query(`select entity_kind, entity_id, op, attempts, last_error_code from hdc_search_outbox order by outbox_id`).then((r) => r.rows);
const docsOf = (collection: Parameters<StubSearch['documents']>[0]) => stub.documents(collection);

beforeEach(async () => {
  f = await seedTwoOrgs();
  stub = createStubSearch();
  setJobQueueForTests(new MemoryJobQueue());
});
afterEach(() => {
  setJobQueueForTests(null);
  setLogSinkForTests(null);
});

test('строка очереди в транзакции изменения: откат не пишет, неиндексируемая колонка не пишет', async () => {
  await pools.root.query(`delete from hdc_search_outbox`);
  const ticketId = f.tickets.aOrg.ticketId;
  await expect(
    withActor(f.l1.actor, async (tx) => {
      await tx.execute(sql`update hdt_tickets set title = 'Новая тема' where ticket_id = ${ticketId}`);
      throw new Error('откат');
    }),
  ).rejects.toThrow('откат');
  expect(await queue()).toEqual([]);
  await asActor(pools.app, f.l1.actor, (c) => c.query(`update hdt_tickets set priority = 'p3' where ticket_id = $1`, [ticketId]));
  expect(await queue()).toEqual([]);
  await asActor(pools.app, f.l1.actor, (c) => c.query(`update hdt_tickets set title = 'Новая тема' where ticket_id = $1`, [ticketId]));
  expect(await queue()).toEqual([{ entity_kind: 'ticket', entity_id: ticketId, op: 'upsert', attempts: 0, last_error_code: null }]);
});

test('клиент и сотрудник очередь не читают и не меняют; система читает', async () => {
  const count = async (actor: Parameters<typeof asActor>[1]) => (await asActor(pools.app, actor, (c) => c.query(`select count(*)::int as n from hdc_search_outbox`))).rows[0].n;
  expect(await count(f.aUser.actor)).toBe(0);
  expect(await count(f.l1.actor)).toBe(0);
  expect(await count(system)).toBeGreaterThan(0);
  const deleted = await asActor(pools.app, f.aUser.actor, (c) => c.query(`delete from hdc_search_outbox`));
  expect(deleted.rowCount).toBe(0);
});

test('обращения и переписка: состав документа, повторы схлопываются, удаление уносит переписку', async () => {
  await pools.root.query(`delete from hdc_search_outbox`);
  const { ticketId, number } = f.tickets.aOrg;
  for (const title of ['Раз', 'Два', 'Накладная не печатается'])
    await asActor(pools.app, f.l1.actor, (c) => c.query(`update hdt_tickets set title = $2 where ticket_id = $1`, [ticketId, title]));
  await asActor(pools.app, f.l1.actor, (c) =>
    c.query(`insert into hdt_ticket_messages (org_id, ticket_id, author_id, author_type, body, is_internal) values ($1, $2, $3, 'staff', 'внутренняя заметка про склад', true)`, [
      f.orgA.orgId,
      ticketId,
      f.l1.userId,
    ]),
  );
  const result = await runSearchSync(system, stub);
  expect(result).toMatchObject({ written: 2, failed: 0 });
  expect(await queue()).toEqual([]);
  const [doc] = docsOf('tickets');
  expect(Object.keys(doc!).sort()).toEqual(['created_on', 'description_ru', 'id', 'number', 'org_id', 'title_fold', 'title_ru', 'version']);
  expect(doc).toMatchObject({ id: ticketId, org_id: f.orgA.orgId, number, title_ru: 'Накладная не печатается', title_fold: 'nakladnaya ne pechataesya' });
  // Ни автора, ни названия организации, ни адресов.
  const all = JSON.stringify(stub.documents('tickets'));
  for (const secret of [f.aUser.name, f.orgA.name, '@']) expect(all).not.toContain(secret);
  const texts = docsOf('ticket_texts');
  expect(texts).toHaveLength(1);
  expect(texts[0]).toMatchObject({ ticket_id: ticketId, org_id: f.orgA.orgId, is_internal: true, body_ru: 'внутренняя заметка про склад' });
  expect(texts[0]!.id.startsWith(`${ticketId}_`)).toBe(true);
  // Удалённое обращение уносит документ и переписку.
  await stub.upsert('ticket_texts', [{ id: `${f.tickets.bOrg.ticketId}_x`, ticket_id: f.tickets.bOrg.ticketId, org_id: f.orgB.orgId, is_internal: false, version: 1 }]);
  await pools.root.query(`delete from hdc_search_outbox`);
  await pools.root.query(`insert into hdc_search_outbox (entity_kind, entity_id, op) values ('ticket', $1, 'delete')`, ['00000000-0000-7000-8000-00000000dead']);
  await stub.upsert('tickets', [{ id: '00000000-0000-7000-8000-00000000dead', org_id: f.orgA.orgId, number: 1, created_on: 1, version: 1 }]);
  await stub.upsert('ticket_texts', [{ id: '00000000-0000-7000-8000-00000000dead_m', ticket_id: '00000000-0000-7000-8000-00000000dead', org_id: f.orgA.orgId, is_internal: true, version: 1 }]);
  await runSearchSync(system, stub);
  expect(docsOf('tickets').map((d) => d.id)).toEqual([ticketId]);
  expect(docsOf('ticket_texts').map((d) => d.ticket_id).sort()).toEqual([ticketId, f.tickets.bOrg.ticketId].sort());
});

describe('решения и идеи', () => {
  let moduleId: string;
  beforeEach(async () => {
    moduleId = (await pools.root.query(`insert into hdr_product_modules (code, name) values ('srch-${Date.now()}-${Math.random()}', '{"ru": "Склад"}') returning module_id`)).rows[0].module_id as string;
    await pools.root.query(`delete from hdc_settings where code = 'kb.allowed_domains'`);
    await pools.root.query(`insert into hdc_settings (code, value) values ('kb.allowed_domains', '["smartup.uz"]')`);
  });
  let serial = 0;
  const newId = () => `srch${String(++serial).padStart(8, '0')}`;
  const p = (id: string, text: string) => ({ type: 'paragraph' as const, attrs: { id }, content: [{ type: 'text' as const, text }] });
  const step = (id: string, text: string) => ({ type: 'step' as const, attrs: { id }, content: [p(`${id}p`, text)] });
  async function draft(title: string, audience: 'clients' | 'internal') {
    return createDraftArticle(staffCtx(f.l1), { locale: 'ru', title, audience, moduleId, doc: { version: 1, blocks: [p(newId(), 'Остаток не сходится'), step(newId(), 'Откройте склад и проверьте остаток')] } });
  }
  async function publish(number: number) {
    const state = await solutionEditorState(staffCtx(f.l1), { number });
    const l2 = staffCtx(await staffWithRole('agent_l2'));
    expect((await publishSolution(l2, { number, locale: 'ru', versionId: state!.current.versionId, revision: state!.current.revision, confirmFindings: false })).status).toBe('published');
    return l2;
  }

  test('черновик не попадает; опубликованное попадает с аудиторией; архив убирает документ', async () => {
    const created = await draft('Остаток склада не сходится', 'clients');
    await runSearchSync(system, stub);
    expect(docsOf('solutions')).toEqual([]);
    const l2 = await publish(created.number);
    await runSearchSync(system, stub);
    const docs = docsOf('solutions');
    expect(docs.map((d) => [d.id, d.audience, d.title_ru])).toEqual([[`${created.articleId}_ru`, 'clients', 'Остаток склада не сходится']]);
    expect(docs[0]!.body_ru).toContain('Откройте склад');
    expect(docs[0]!.module_ids).toEqual([moduleId]);
    await archiveSolution(l2, { number: created.number });
    await runSearchSync(system, stub);
    expect(docsOf('solutions')).toEqual([]);
  });

  test('сужение аудитории до internal меняет документ: ключ клиента его больше не отдаёт', async () => {
    const created = await draft('Внутреннее про склад', 'clients');
    await publish(created.number);
    await runSearchSync(system, stub);
    await pools.root.query(`update hdk_articles set audience = 'internal' where article_id = $1`, [created.articleId]);
    await runSearchSync(system, stub);
    expect(docsOf('solutions').map((d) => d.audience)).toEqual(['internal']);
  });

  test('идеи: на модерации нет, опубликованная есть без автора и организации, отклонение и объединение убирают', async () => {
    const pending = await addIdea(f.orgB.orgId, f.bUser, 'pending_review', { title: 'Печать накладных пачкой' });
    const target = await addIdea(f.orgB.orgId, f.bUser, 'open', { title: 'Печать накладных одной кнопкой' });
    await runSearchSync(system, stub);
    expect(docsOf('ideas').map((d) => d.idea_id)).toEqual([target.ideaId]);
    const doc = docsOf('ideas')[0]!;
    expect(Object.keys(doc).sort()).toEqual(['body_fold', 'body_ru', 'id', 'idea_id', 'locale', 'status', 'title_fold', 'title_ru', 'version']);
    expect(JSON.stringify(doc)).not.toContain(f.bUser.name);
    await pools.root.query(`update hdi_ideas set status = 'open' where idea_id = $1`, [pending.ideaId]);
    await runSearchSync(system, stub);
    expect(docsOf('ideas').map((d) => d.idea_id).sort()).toEqual([pending.ideaId, target.ideaId].sort());
    await pools.root.query(`update hdi_ideas set status = 'merged', merged_into_id = $2 where idea_id = $1`, [pending.ideaId, target.ideaId]);
    await runSearchSync(system, stub);
    expect(docsOf('ideas').map((d) => d.idea_id)).toEqual([target.ideaId]);
    await pools.root.query(`update hdi_ideas set status = 'declined', decline_reason = 'дубль' where idea_id = $1`, [target.ideaId]);
    await runSearchSync(system, stub);
    expect(docsOf('ideas')).toEqual([]);
  });
});

test('организации и люди без адресов почты; сотрудник отмечен', async () => {
  await runSearchSync(system, stub);
  const orgs = docsOf('orgs');
  expect(orgs.map((o) => o.name).sort()).toEqual(expect.arrayContaining([f.orgA.name, f.orgB.name]));
  const people = docsOf('people');
  expect(people.find((p) => p.id === f.l1.userId)).toMatchObject({ name: f.l1.name, is_staff: true });
  expect(people.find((p) => p.id === f.aUser.userId)).toMatchObject({ is_staff: false, org_ids: [f.orgA.orgId] });
  expect(JSON.stringify(people)).not.toMatch(/@/);
  for (const doc of people) expect(Object.keys(doc).sort().join(',')).toMatch(/^id,is_staff,name,name_fold,(org_ids,)?version$/);
});

test('сбой записи оставляет строку с кодом и паузой; после пятого сбоя строка не берётся', async () => {
  await pools.root.query(`delete from hdc_search_outbox`);
  await asActor(pools.app, f.l1.actor, (c) => c.query(`update hdt_tickets set title = 'Сбой' where ticket_id = $1`, [f.tickets.aOrg.ticketId]));
  const broken: SearchIndexWriter = { ...stub, upsert: async () => { throw new SearchWriteError('http_503'); } };
  const events: string[] = [];
  setLogSinkForTests((_level, event, fields) => events.push(`${event} ${JSON.stringify(fields)}`));
  const now = new Date();
  expect(await runSearchSync(system, broken, { now })).toMatchObject({ failed: 1, dropped: 0 });
  expect(await queue()).toEqual([{ entity_kind: 'ticket', entity_id: f.tickets.aOrg.ticketId, op: 'upsert', attempts: 1, last_error_code: 'http_503' }]);
  // Пауза 10 секунд: сразу строка не берётся.
  expect(await runSearchSync(system, broken, { now })).toMatchObject({ failed: 0 });
  for (let i = 1; i < 5; i++) await runSearchSync(system, broken, { now: new Date(now.getTime() + i * 3_600_000) });
  expect((await queue())[0]).toMatchObject({ attempts: 5 });
  expect(await runSearchSync(system, broken, { now: new Date(now.getTime() + 10 * 3_600_000) })).toMatchObject({ failed: 0 });
  expect(events.some((e) => e.startsWith('search.sync_failed') && e.includes('"dropped":1'))).toBe(true);
  // В событии нет текста и идентификаторов.
  expect(events.join('\n')).not.toContain('Сбой');
  expect(events.join('\n')).not.toContain(f.tickets.aOrg.ticketId);
});

test('без Typesense (SEARCH_PROVIDER=postgres) очередь очищается', async () => {
  expect((await queue()).length).toBeGreaterThan(0);
  expect((await runSearchSync(system, null)).cleared).toBeGreaterThan(0);
  expect(await queue()).toEqual([]);
});

describe.skipIf(typesenseSkip !== null)(`переиндексация на Typesense${typesenseSkip ? ` (пропущено: ${typesenseSkip})` : ''}`, () => {
  test('строит v2, переключает псевдоним, число документов совпадает, аудит без текста', async () => {
    const live = await liveSearch();
    await runSearchSync(system, live.writer);
    const before = await live.writer.exportVersions('tickets');
    const result = await reindexCollection(system, live.writer, 'tickets');
    expect(result).toEqual({ name: 'hub_tickets_v2', documents: 5 });
    expect(await live.writer.aliasTarget('tickets')).toBe('hub_tickets_v2');
    expect([...(await live.writer.exportVersions('tickets')).keys()].sort()).toEqual([...before.keys()].sort());
    const audit = (await pools.root.query(`select diff from hdc_audit_log where action = 'search.reindexed'`)).rows;
    expect(audit).toEqual([{ diff: { collection: 'tickets', version: 2, documents: 5 } }]);
  });
});
