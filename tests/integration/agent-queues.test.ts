import { expect, test } from 'vitest';
import { deleteFilter, listFilters, listQueue, nextInQueue, queueCounts, saveFilter } from '@/modules/hdt/api';
import { staffCtx } from './helpers/auth';
import { asActor, pools } from './helpers/db';
import { seedTwoOrgs } from './isolation/fixture';

// Очереди, поиск и сохранённые фильтры рабочего места (FR-AG-01, 10, 14, 18, UX-A-08, 09; план M3, задача 5).

const numbers = (items: { number: number }[]) => items.map((i) => i.number);
const set = (ticketId: string, change: string, params: unknown[] = []) => pools.root.query(`update hdt_tickets set ${change} where ticket_id = $1`, [ticketId, ...params]);

test('очереди FR-AG-01: по статусу, исполнителю, линии и сроку', async () => {
  const f = await seedTwoOrgs();
  const t = f.tickets;
  const l1 = staffCtx(f.l1);
  await set(t.aOrg.ticketId, `status = 'in_progress', assignee_id = $2`, [f.l1.userId]);
  await set(t.aPrivate.ticketId, `status = 'in_progress', queue = 'l2'`);
  await set(t.aMine.ticketId, `status = 'waiting_customer'`);
  await set(t.bOrg.ticketId, `status = 'in_development'`);
  await set(t.bPrivate.ticketId, `first_response_due_on = now() - interval '5 minutes'`);
  const queue = async (name: string) => numbers((await listQueue(l1, { queue: name })).items);
  expect(await queue('new')).toEqual([t.bPrivate.number]);
  expect(await queue('mine')).toEqual([t.aOrg.number]);
  expect(await queue('l2')).toEqual([t.aPrivate.number]);
  expect(await queue('waiting')).toEqual([t.aMine.number]);
  expect(await queue('development')).toEqual([t.bOrg.number]);
  expect(await queue('breached')).toEqual([t.bPrivate.number]);
  expect((await queue('all')).sort()).toEqual([t.aOrg, t.aPrivate, t.aMine, t.bOrg, t.bPrivate].map((x) => x.number).sort());
  // Решённое и закрытое не нарушают срок, даже если он в прошлом.
  await set(t.bPrivate.ticketId, `status = 'in_progress'`);
  await set(t.bPrivate.ticketId, `status = 'resolved'`);
  expect(await queue('breached')).toEqual([]);
});

test('по умолчанию ближайший срок первым, "клиент ждёт дольше всего" по client_waiting_since', async () => {
  const f = await seedTwoOrgs();
  const t = f.tickets;
  const l1 = staffCtx(f.l1);
  await set(t.aOrg.ticketId, `first_response_due_on = now() + interval '3 hours', client_waiting_since = now() - interval '10 minutes'`);
  await set(t.aPrivate.ticketId, `first_response_due_on = now() + interval '9 minutes', client_waiting_since = now() - interval '1 minute'`);
  await set(t.aMine.ticketId, `first_response_due_on = now() + interval '41 minutes', client_waiting_since = now() - interval '2 hours'`);
  // После первого ответа сортируется по сроку решения.
  await set(t.bOrg.ticketId, `first_responded_on = now(), first_response_due_on = now() - interval '1 day', resolution_due_on = now() + interval '1 hour', client_waiting_since = null`);
  await set(t.bPrivate.ticketId, `first_response_due_on = null, client_waiting_since = null`);
  expect(numbers((await listQueue(l1, { queue: 'all' })).items)).toEqual([t.aPrivate.number, t.aMine.number, t.bOrg.number, t.aOrg.number, t.bPrivate.number]);
  expect(numbers((await listQueue(l1, { queue: 'all', sort: 'client_waiting' })).items).slice(0, 3)).toEqual([t.aMine.number, t.aOrg.number, t.aPrivate.number]);
  // Состояние срока у строки: спокойно, скоро, нарушен (UX-A-08).
  const row = (await listQueue(l1, { queue: 'all' })).items.find((i) => i.number === t.aPrivate.number);
  expect(row?.slaPhase).toMatch(/calm|soon/);
  await set(t.aPrivate.ticketId, `first_response_due_on = now() - interval '1 minute'`);
  expect((await listQueue(l1, { queue: 'all' })).items.find((i) => i.number === t.aPrivate.number)?.slaPhase).toBe('breached');
});

test('поиск по номеру, тексту, названию организации, ИНН, имени и адресу автора', async () => {
  const f = await seedTwoOrgs();
  const t = f.tickets;
  const l1 = staffCtx(f.l1);
  await pools.root.query(`update hdu_organizations set inn = '305112233' where org_id = $1`, [f.orgB.orgId]);
  await pools.root.query(`update auth."user" set email = 'alisher@acme.example', "emailVerified" = true where id = $1`, [f.aUser.userId]);
  const search = async (q: string) => numbers((await listQueue(l1, { queue: 'all', q })).items).sort();
  expect(await search(`SUP-${t.bOrg.number}`)).toEqual([t.bOrg.number]);
  expect(await search('накладная не проводится')).toEqual([t.bOrg.number]);
  expect(await search('Globex')).toEqual([t.bOrg.number, t.bPrivate.number].sort());
  expect(await search('305112233')).toEqual([t.bOrg.number, t.bPrivate.number].sort());
  expect(await search('Алишер')).toEqual([t.aOrg.number, t.aMine.number].sort());
  expect(await search('alisher@acme')).toEqual([t.aOrg.number, t.aMine.number].sort());
  expect(await search('ничего такого нет')).toEqual([]);
  // Знаки шаблона LIKE ищутся как текст.
  expect(await search('%')).toEqual([]);
});

test('отложенное скрыто из рабочих очередей до своего времени, в "Все" и "Мои" видно с отметкой', async () => {
  const f = await seedTwoOrgs();
  const t = f.tickets;
  const l1 = staffCtx(f.l1);
  await set(t.bPrivate.ticketId, `snoozed_until = now() + interval '1 hour', assignee_id = $2`, [f.l1.userId]);
  expect(numbers((await listQueue(l1, { queue: 'new' })).items)).not.toContain(t.bPrivate.number);
  const inAll = (await listQueue(l1, { queue: 'all' })).items.find((i) => i.number === t.bPrivate.number);
  expect(inAll?.snoozedUntil).not.toBeNull();
  expect(numbers((await listQueue(l1, { queue: 'mine' })).items)).toContain(t.bPrivate.number);
  // Время прошло: обращение снова в рабочей очереди.
  await set(t.bPrivate.ticketId, `snoozed_until = now() - interval '1 minute'`);
  expect(numbers((await listQueue(l1, { queue: 'new' })).items)).toContain(t.bPrivate.number);
});

test('счётчики совпадают со списками', async () => {
  const f = await seedTwoOrgs();
  const l1 = staffCtx(f.l1);
  await set(f.tickets.aOrg.ticketId, `status = 'waiting_customer', assignee_id = $2`, [f.l1.userId]);
  await set(f.tickets.bOrg.ticketId, `queue = 'l2'`);
  const counts = await queueCounts(l1);
  for (const queue of ['new', 'mine', 'l2', 'waiting', 'development', 'breached', 'all'] as const)
    expect(counts[queue], queue).toBe((await listQueue(l1, { queue })).items.length);
});

test('сохранённый фильтр: свой виден только мне, общий всем сотрудникам, клиенту ничего', async () => {
  const f = await seedTwoOrgs();
  const l1 = staffCtx(f.l1);
  const care = staffCtx(f.care);
  await saveFilter(l1, { name: 'Мои P1', query: { queue: 'mine', sort: 'sla', q: 'P1' }, isShared: false });
  await saveFilter(l1, { name: 'Склад', query: { queue: 'all', sort: 'client_waiting', q: 'склад' }, isShared: true });
  expect((await listFilters(l1)).map((x) => x.name).sort()).toEqual(['Мои P1', 'Склад']);
  expect((await listFilters(care)).map((x) => x.name)).toEqual(['Склад']);
  // Чужой фильтр удалить нельзя, свой можно.
  const shared = (await listFilters(care))[0];
  await expect(deleteFilter(care, shared?.filterId)).rejects.toMatchObject({ code: 'not_found' });
  await deleteFilter(l1, shared?.filterId);
  expect((await listFilters(care)).map((x) => x.name)).toEqual([]);
  // Клиенту не видно ни одного фильтра даже прямым запросом.
  expect((await asActor(pools.app, f.aAdmin.actor, (c) => c.query('select 1 from hdt_saved_filters'))).rows).toEqual([]);
  await expect(saveFilter(l1, { name: '', query: { queue: 'all' }, isShared: false })).rejects.toMatchObject({ code: 'invalid_input' });
});

test('"Отправить и к следующему": следующее обращение той же очереди и сортировки, после последнего пусто (FR-AG-17)', async () => {
  const f = await seedTwoOrgs();
  const t = f.tickets;
  const l1 = staffCtx(f.l1);
  for (const ticket of [t.aOrg, t.aMine, t.bOrg]) await set(ticket.ticketId, `status = 'in_progress', assignee_id = $2`, [f.l1.userId]);
  const mine = numbers((await listQueue(l1, { queue: 'mine', sort: 'updated' })).items);
  expect(mine).toHaveLength(3);
  expect(await nextInQueue(l1, { queue: 'mine', sort: 'updated', afterNumber: mine[0] })).toBe(mine[1]);
  expect(await nextInQueue(l1, { queue: 'mine', sort: 'updated', afterNumber: mine[1] })).toBe(mine[2]);
  expect(await nextInQueue(l1, { queue: 'mine', sort: 'updated', afterNumber: mine[2] })).toBeNull();
  // Текущего в очереди уже нет (ответ увёл его из "Новых"): берётся первое другое.
  expect(await nextInQueue(l1, { queue: 'mine', sort: 'updated', afterNumber: t.bPrivate.number })).toBe(mine[0]);
});
