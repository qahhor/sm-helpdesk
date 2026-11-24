import { beforeEach, expect, test } from 'vitest';
import { deleteTag, listTags, updateTag } from '@/modules/hdr/api';
import { addTicketTag, getAgentTicket, getTicket, listQueue, removeTicketTag, tagUsage } from '@/modules/hdt/api';
import { clientCtx, staffCtx, staffWithRole } from './helpers/auth';
import { captureQueries, plansFor, seedBulkTickets } from './helpers/bulk';
import { asActor, pools } from './helpers/db';
import { type Fixture, seedTwoOrgs } from './isolation/fixture';

// Теги обращений (FR-AUTO-13; план M8, задача 1, решение 8): ставит сотрудник с правом записи, тег создаётся на лету,
// переименовать, перекрасить и удалить может администратор. Клиент не видит тегов нигде.

let f: Fixture;
beforeEach(async () => {
  f = await seedTwoOrgs();
});

const tagEvents = (ticketId: string) =>
  pools.root
    .query(`select payload, is_internal, actor_id from hdt_ticket_events where ticket_id = $1 and kind = 'tag' order by created_on, event_id`, [ticketId])
    .then((r) => r.rows);
const audit = (objectId: string) =>
  pools.root.query(`select action from hdc_audit_log where object_id = $1 order by created_on, audit_id`, [objectId]).then((r) => r.rows.map((x) => x.action as string));
const tagRows = () => pools.root.query(`select tag_id, name, color from hdr_tags order by name`).then((r) => r.rows);

test('первая линия ставит тег: тег создаётся на лету, пишутся внутреннее событие и журнал', async () => {
  const l1 = staffCtx(f.l1);
  const t = f.tickets.aOrg;
  await addTicketTag(l1, { number: t.number, name: '  Срочно  ' });
  const tags = await tagRows();
  expect(tags).toMatchObject([{ name: 'Срочно', color: 'gray' }]);
  const tagId = tags[0].tag_id as string;
  expect(await tagEvents(t.ticketId)).toEqual([{ payload: { action: 'added', tagId, name: 'Срочно' }, is_internal: true, actor_id: f.l1.userId }]);
  expect(await audit(t.ticketId)).toContain('ticket.tag_added');
  expect(await audit(tagId)).toEqual(['tag.created']);
  const link = (await pools.root.query(`select org_id, added_by from hdt_ticket_tags where ticket_id = $1`, [t.ticketId])).rows;
  expect(link).toEqual([{ org_id: f.orgA.orgId, added_by: f.l1.userId }]);

  // Тот же тег в другом регистре: новый не создаётся, повторная постановка ничего не добавляет.
  await addTicketTag(l1, { number: t.number, name: 'срочно' });
  await addTicketTag(l1, { number: f.tickets.bOrg.number, name: 'СРОЧНО' });
  expect(await tagRows()).toHaveLength(1);
  expect(await tagEvents(t.ticketId)).toHaveLength(1);
  expect(await tagEvents(f.tickets.bOrg.ticketId)).toHaveLength(1);
  expect((await listTags(l1)).map((tag) => tag.name)).toEqual(['Срочно']);
});

test('снятие тега пишет событие и журнал, снять снятое нельзя', async () => {
  const l1 = staffCtx(f.l1);
  const t = f.tickets.aOrg;
  await addTicketTag(l1, { number: t.number, name: 'Оплата' });
  const [tag] = await listTags(l1);
  if (!tag) throw new Error('тега нет');
  await removeTicketTag(staffCtx(f.care), { number: t.number, tagId: tag.tagId });
  expect((await tagEvents(t.ticketId)).map((e) => [e.payload.action, e.actor_id])).toEqual([
    ['added', f.l1.userId],
    ['removed', f.care.userId],
  ]);
  expect(await audit(t.ticketId)).toContain('ticket.tag_removed');
  expect((await pools.root.query(`select 1 from hdt_ticket_tags`)).rowCount).toBe(0);
  await expect(removeTicketTag(l1, { number: t.number, tagId: tag.tagId })).rejects.toMatchObject({ code: 'not_found' });
  // Сам тег остаётся в справочнике.
  expect(await tagRows()).toHaveLength(1);
});

test('негодные данные отклоняются', async () => {
  const l1 = staffCtx(f.l1);
  const t = f.tickets.aOrg;
  for (const name of ['', '   ', 'x'.repeat(41)]) await expect(addTicketTag(l1, { number: t.number, name }), name).rejects.toMatchObject({ code: 'invalid_input' });
  await expect(addTicketTag(l1, { number: 999_999, name: 'Срочно' })).rejects.toMatchObject({ code: 'not_found' });
  await expect(removeTicketTag(l1, { number: t.number, tagId: 'не-идентификатор' })).rejects.toMatchObject({ code: 'invalid_input' });
  // Откат: тег, созданный для несуществующего обращения, не остаётся.
  expect(await tagRows()).toEqual([]);
});

test('роль product тегов не ставит и не снимает: отказ сервиса и политики базы', async () => {
  const product = await staffWithRole('product');
  const t = f.tickets.aOrg;
  await addTicketTag(staffCtx(f.l1), { number: t.number, name: 'Срочно' });
  const [tag] = await listTags(staffCtx(product));
  if (!tag) throw new Error('product должен читать теги');
  await expect(addTicketTag(staffCtx(product), { number: t.number, name: 'Новый' })).rejects.toMatchObject({ code: 'forbidden' });
  await expect(removeTicketTag(staffCtx(product), { number: t.number, tagId: tag.tagId })).rejects.toMatchObject({ code: 'forbidden' });
  // В обход сервиса: политика строк.
  await expect(asActor(pools.app, product.actor, (c) => c.query(`insert into hdr_tags (name, color) values ('Мимо', 'gray')`))).rejects.toThrow(/row-level security/);
  await expect(
    asActor(pools.app, product.actor, (c) => c.query(`insert into hdt_ticket_tags (org_id, ticket_id, tag_id, added_by) values ($1, $2, $3, $4)`, [f.orgB.orgId, f.tickets.bOrg.ticketId, tag.tagId, product.userId])),
  ).rejects.toThrow(/row-level security/);
  expect((await asActor(pools.app, product.actor, (c) => c.query(`delete from hdt_ticket_tags`))).rowCount).toBe(0);
  expect((await pools.root.query(`select 1 from hdt_ticket_tags`)).rowCount).toBe(1);
});

test('клиент не видит тегов: ни в обращении, ни в истории, ни в таблицах', async () => {
  const t = f.tickets.aOrg;
  await addTicketTag(staffCtx(f.l1), { number: t.number, name: 'Секретный-тег' });
  await addTicketTag(staffCtx(f.l1), { number: t.number, name: 'Второй' });
  const [second] = (await listTags(staffCtx(f.l1))).filter((tag) => tag.name === 'Второй');
  await removeTicketTag(staffCtx(f.l1), { number: t.number, tagId: second?.tagId });
  for (const member of [f.aUser, f.aAdmin]) {
    const view = await getTicket(await clientCtx(member), t.number);
    if (!view) throw new Error('клиент должен видеть обращение');
    expect(JSON.stringify(view)).not.toContain('Секретный-тег');
    expect(JSON.stringify(view)).not.toContain('Второй');
    expect(view).not.toHaveProperty('tags');
    expect(view.events.filter((event) => (event.kind as string) === 'tag')).toEqual([]);
    for (const table of ['hdr_tags', 'hdt_ticket_tags'])
      expect((await asActor(pools.app, member.actor, (c) => c.query(`select 1 from ${table}`))).rowCount, table).toBe(0);
    expect((await asActor(pools.app, member.actor, (c) => c.query(`select 1 from hdt_ticket_events where kind = 'tag'`))).rowCount).toBe(0);
    await expect(asActor(pools.app, member.actor, (c) => c.query(`insert into hdr_tags (name, color) values ('Клиент', 'gray')`))).rejects.toThrow(/row-level security/);
  }
  // Событие тега база не принимает видимым клиенту.
  await expect(
    pools.root.query(`insert into hdt_ticket_events (org_id, ticket_id, kind, actor_type, is_internal) values ($1, $2, 'tag', 'staff', false)`, [f.orgA.orgId, t.ticketId]),
  ).rejects.toThrow(/hdt_ticket_events_c3/);
});

test('сотрудник видит теги на обращении, в истории и в очереди; фильтр по тегу отбирает обращения', async () => {
  const l1 = staffCtx(f.l1);
  await addTicketTag(l1, { number: f.tickets.aOrg.number, name: 'Оплата' });
  await addTicketTag(l1, { number: f.tickets.aOrg.number, name: 'Срочно' });
  await addTicketTag(l1, { number: f.tickets.bOrg.number, name: 'Срочно' });
  const tags = await listTags(l1);
  const urgent = tags.find((tag) => tag.name === 'Срочно');
  const payment = tags.find((tag) => tag.name === 'Оплата');
  if (!urgent || !payment) throw new Error('тегов нет');

  const view = await getAgentTicket(l1, f.tickets.aOrg.number);
  expect(view?.tags.map((tag) => [tag.name, tag.color])).toEqual([
    ['Оплата', 'gray'],
    ['Срочно', 'gray'],
  ]);
  expect(view?.timeline.filter((entry) => entry.type === 'event' && entry.kind === 'tag')).toHaveLength(2);

  const all = await listQueue(l1, { queue: 'all' });
  expect(all.items.find((row) => row.number === f.tickets.aOrg.number)?.tags.map((tag) => tag.name)).toEqual(['Оплата', 'Срочно']);
  expect(all.items.find((row) => row.number === f.tickets.aPrivate.number)?.tags).toEqual([]);
  const byUrgent = await listQueue(l1, { queue: 'all', tag: urgent.tagId });
  expect(byUrgent.items.map((row) => row.number).sort()).toEqual([f.tickets.aOrg.number, f.tickets.bOrg.number].sort());
  const byPayment = await listQueue(l1, { queue: 'all', tag: payment.tagId });
  expect(byPayment.items.map((row) => row.number)).toEqual([f.tickets.aOrg.number]);
  await expect(listQueue(l1, { queue: 'all', tag: 'срочно' })).rejects.toMatchObject({ code: 'invalid_input' });
});

test('переименовать, перекрасить и удалить тег может только администратор со свежим входом', async () => {
  const admin = staffCtx(f.adminStaff);
  const stale = { ...admin, sessionCreatedAt: new Date(Date.now() - 901e3) };
  await addTicketTag(staffCtx(f.l1), { number: f.tickets.aOrg.number, name: 'Срочно' });
  await addTicketTag(staffCtx(f.l1), { number: f.tickets.bOrg.number, name: 'Срочно' });
  await addTicketTag(staffCtx(f.l1), { number: f.tickets.bOrg.number, name: 'Оплата' });
  const tags = await listTags(admin);
  const urgent = tags.find((tag) => tag.name === 'Срочно');
  const payment = tags.find((tag) => tag.name === 'Оплата');
  if (!urgent || !payment) throw new Error('тегов нет');
  expect(Object.fromEntries(await tagUsage(admin))).toEqual({ [urgent.tagId]: 2, [payment.tagId]: 1 });

  for (const ctx of [staffCtx(f.l1), staffCtx(f.care)]) {
    await expect(updateTag(ctx, { tagId: urgent.tagId, name: 'Горит', color: 'red' })).rejects.toMatchObject({ code: 'forbidden' });
    await expect(deleteTag(ctx, { tagId: urgent.tagId })).rejects.toMatchObject({ code: 'forbidden' });
    await expect(tagUsage(ctx)).rejects.toMatchObject({ code: 'forbidden' });
  }
  await expect(updateTag(stale, { tagId: urgent.tagId, name: 'Горит', color: 'red' })).rejects.toMatchObject({ code: 'stale_session' });
  await expect(deleteTag(stale, { tagId: urgent.tagId })).rejects.toMatchObject({ code: 'stale_session' });
  // В обход сервиса: политика строк не даёт первой линии ни изменить, ни удалить тег.
  expect((await asActor(pools.app, f.l1.actor, (c) => c.query(`update hdr_tags set name = 'Мимо'`))).rowCount).toBe(0);
  expect((await asActor(pools.app, f.l1.actor, (c) => c.query(`delete from hdr_tags`))).rowCount).toBe(0);

  await expect(updateTag(admin, { tagId: urgent.tagId, name: 'оплата', color: 'red' })).rejects.toMatchObject({ code: 'tag_taken' });
  await expect(updateTag(admin, { tagId: urgent.tagId, name: 'Горит', color: 'лиловый' })).rejects.toMatchObject({ code: 'invalid_input' });
  await updateTag(admin, { tagId: urgent.tagId, name: 'Горит', color: 'red' });
  // Смена только регистра своего же названия разрешена.
  await updateTag(admin, { tagId: urgent.tagId, name: 'ГОРИТ', color: 'red' });
  expect(await tagRows()).toMatchObject([
    { name: 'ГОРИТ', color: 'red' },
    { name: 'Оплата', color: 'gray' },
  ]);
  expect(await audit(urgent.tagId)).toEqual(['tag.created', 'tag.updated', 'tag.updated']);

  await deleteTag(admin, { tagId: urgent.tagId });
  expect((await tagRows()).map((row) => row.name)).toEqual(['Оплата']);
  expect((await pools.root.query(`select tag_id from hdt_ticket_tags`)).rows).toEqual([{ tag_id: payment.tagId }]);
  expect(await audit(urgent.tagId)).toContain('tag.deleted');
  await expect(deleteTag(admin, { tagId: urgent.tagId })).rejects.toMatchObject({ code: 'not_found' });
  // История обращения хранит название тега в событии и читается после удаления тега.
  const view = await getAgentTicket(admin, f.tickets.aOrg.number);
  expect(view?.tags).toEqual([]);
  expect(view?.timeline.filter((entry) => entry.type === 'event' && entry.kind === 'tag')).toMatchObject([{ payload: { action: 'added', name: 'Срочно' } }]);
});

test('база держит уникальность названия без учёта регистра и цвет из перечня', async () => {
  await pools.root.query(`insert into hdr_tags (name, color) values ('Склад', 'teal')`);
  await expect(pools.root.query(`insert into hdr_tags (name, color) values ('СКЛАД', 'teal')`)).rejects.toThrow(/hdr_tags_u1/);
  await expect(pools.root.query(`insert into hdr_tags (name, color) values ('Цвет', '#ff0000')`)).rejects.toThrow(/hdr_tags_c2/);
  await expect(pools.root.query(`insert into hdr_tags (name, color) values ('', 'gray')`)).rejects.toThrow(/hdr_tags_c1/);
});

test('фильтр по тегу на 50 тысячах обращений идёт по индексам', async () => {
  await seedBulkTickets(50_000, 200, f.l1.userId);
  // 25 тегов, каждый на тысяче обращений: половина обращений с тегом.
  await pools.root.query(`insert into hdr_tags (name, color) select 'Нагрузка ' || g, 'blue' from generate_series(0, 24) g`);
  await pools.root.query(
    `insert into hdt_ticket_tags (org_id, ticket_id, tag_id, added_by)
     select t.org_id, t.ticket_id, g.tag_id, $1
       from (select org_id, ticket_id, row_number() over (order by ticket_id) as n from hdt_tickets) t
       join (select tag_id, row_number() over (order by name) - 1 as k from hdr_tags) g on g.k = (t.n / 2) % 25
      where t.n % 2 = 0`,
    [f.l1.userId],
  );
  await pools.root.query(`analyze hdt_ticket_tags`);
  const tagId = (await pools.root.query(`select tag_id from hdr_tags where name = 'Нагрузка 7'`)).rows[0].tag_id as string;
  const { result, queries } = await captureQueries(() => listQueue(staffCtx(f.l1), { queue: 'all', sort: 'updated', tag: tagId }));
  expect(result.items).toHaveLength(50);
  expect(result.hasMore).toBe(true);
  expect(result.items.every((row) => row.tags.map((tag) => tag.name).join() === 'Нагрузка 7')).toBe(true);
  const filtered = queries.filter((query) => query.text.includes('hdt_ticket_tags'));
  expect(filtered.length).toBeGreaterThan(0);
  for (const table of ['hdt_tickets', 'hdt_ticket_tags']) {
    const plans = await plansFor(f.l1.actor, filtered, table);
    expect(plans.length, table).toBeGreaterThan(0);
    for (const plan of plans) expect(plan, plan).not.toMatch(/Seq Scan on hdt_ticket/);
  }
  // Следующая страница по ключу листания тоже отбирает по тегу.
  const next = await listQueue(staffCtx(f.l1), { queue: 'all', sort: 'updated', tag: tagId, after: result.nextCursor });
  expect(next.items).toHaveLength(50);
  expect(next.items.some((row) => result.items.some((first) => first.number === row.number))).toBe(false);
}, 120_000);
