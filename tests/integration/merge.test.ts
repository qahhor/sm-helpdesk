import { expect, test } from 'vitest';
import { bulkAction, createTicket, getAgentTicket, getTicket, mergeTicket, reopenTicket, takeTicket } from '@/modules/hdt/api';
import { clientCtx, staffCtx, staffWithRole } from './helpers/auth';
import { asActor, pools } from './helpers/db';
import { seedTwoOrgs } from './isolation/fixture';

// Объединение дублей и массовые действия (FR-AG-07, FR-AG-20, UX-A-10; план M3, задача 11, решение 4).

const row = (ticketId: string) =>
  pools.root
    .query(`select status, resolution_type, merged_into_id, closed_on, assignee_id, queue from hdt_tickets where ticket_id = $1`, [ticketId])
    .then((r) => r.rows[0]);
const audit = (ticketId: string) =>
  pools.root.query(`select action from hdc_audit_log where object_id = $1 order by created_on, audit_id`, [ticketId]).then((r) => r.rows.map((x) => x.action as string));
const newTicket = async (member: { userId: string }, description: string) => {
  const { number } = await createTicket(await clientCtx(member), { description, type: 'bug', impact: 'minor', locale: 'ru' });
  const ticketId = (await pools.root.query(`select ticket_id from hdt_tickets where number = $1`, [number])).rows[0].ticket_id as string;
  return { number, ticketId };
};

test('дубль закрыт с итогом "дубль" и ссылкой, клиент видит сообщение и номер основного', async () => {
  const f = await seedTwoOrgs();
  const l1 = staffCtx(f.l1);
  const main = f.tickets.aOrg;
  const dup = await newTicket(f.aUser, 'Отчёт не грузится, пишу второй раз');
  await takeTicket(l1, dup.number);
  await mergeTicket(l1, { number: dup.number, intoNumber: main.number });
  expect(await row(dup.ticketId)).toMatchObject({ status: 'closed', resolution_type: 'duplicate', merged_into_id: main.ticketId });
  expect((await row(dup.ticketId)).closed_on).not.toBeNull();
  expect(await audit(dup.ticketId)).toContain('ticket.merged');
  expect(await audit(main.ticketId)).toContain('ticket.merged');
  const view = await getTicket(await clientCtx(f.aUser), dup.number);
  expect(view?.mergedInto).toEqual({ number: main.number });
  expect(view?.events.map((e) => e.kind)).toContain('merge');
  expect(view?.can.reopen).toBe(false);
  // В основном обращении событие внутреннее: номер дубля клиенту основного не показывается.
  const mainEvents = await pools.root.query(`select is_internal, payload from hdt_ticket_events where ticket_id = $1 and kind = 'merge'`, [main.ticketId]);
  expect(mainEvents.rows).toEqual([{ is_internal: true, payload: { from: dup.number } }]);
  expect((await getAgentTicket(l1, dup.number))?.mergedInto).toEqual({ number: main.number });
});

test('клиент дубля не видит номер основного, если основное ему не видно', async () => {
  const f = await seedTwoOrgs();
  // Основное: личное обращение администратора клиента, aUser его не видит.
  const dup = await newTicket(f.aUser, 'То же, что у администратора');
  await mergeTicket(staffCtx(f.l1), { number: dup.number, intoNumber: f.tickets.aPrivate.number });
  const view = await getTicket(await clientCtx(f.aUser), dup.number);
  expect(view?.mergedInto).toBeNull();
  expect(view?.status).toBe('closed');
  expect(JSON.stringify(view)).not.toContain(String(f.tickets.aPrivate.number));
});

test('объединение с объединённым идёт к конечному основному', async () => {
  const f = await seedTwoOrgs();
  const l1 = staffCtx(f.l1);
  const main = f.tickets.aOrg;
  const middle = await newTicket(f.aUser, 'Второй раз');
  const third = await newTicket(f.aUser, 'Третий раз');
  await mergeTicket(l1, { number: middle.number, intoNumber: main.number });
  await mergeTicket(l1, { number: third.number, intoNumber: middle.number });
  expect((await row(third.ticketId)).merged_into_id).toBe(main.ticketId);
});

test('само с собой, другая организация и закрытое отклоняются', async () => {
  const f = await seedTwoOrgs();
  const l1 = staffCtx(f.l1);
  const a = f.tickets.aOrg;
  await expect(mergeTicket(l1, { number: a.number, intoNumber: a.number })).rejects.toMatchObject({ code: 'merge_refused' });
  await expect(mergeTicket(l1, { number: a.number, intoNumber: f.tickets.bOrg.number })).rejects.toMatchObject({ code: 'merge_refused' });
  const dup = await newTicket(f.aUser, 'Дубль');
  await mergeTicket(l1, { number: dup.number, intoNumber: a.number });
  // Обращение, которое объединяют с его же дублем: цепочка ведёт к самому себе.
  await expect(mergeTicket(l1, { number: a.number, intoNumber: dup.number })).rejects.toMatchObject({ code: 'merge_refused' });
  await expect(mergeTicket(l1, { number: dup.number, intoNumber: f.tickets.aMine.number })).rejects.toMatchObject({ code: 'transition_refused' });
  await pools.root.query(`update hdt_tickets set status = 'closed' where ticket_id = $1`, [f.tickets.aMine.ticketId]);
  const other = await newTicket(f.aUser, 'Ещё дубль');
  await expect(mergeTicket(l1, { number: other.number, intoNumber: f.tickets.aMine.number })).rejects.toMatchObject({ code: 'transition_refused' });
  await expect(mergeTicket(staffCtx(await staffWithRole('product')), { number: other.number, intoNumber: a.number })).rejects.toMatchObject({ code: 'forbidden' });
  await expect(mergeTicket(l1, { number: other.number, intoNumber: 999_999 })).rejects.toMatchObject({ code: 'not_found' });
});

test('объединённое нельзя открыть заново', async () => {
  const f = await seedTwoOrgs();
  const dup = await newTicket(f.aUser, 'Дубль для повторного открытия');
  await mergeTicket(staffCtx(f.l1), { number: dup.number, intoNumber: f.tickets.aOrg.number });
  await expect(reopenTicket(await clientCtx(f.aUser), { number: dup.number })).rejects.toMatchObject({ code: 'merged' });
  // Второй слой: база не даёт клиенту сменить статус объединённого даже в обход сервиса.
  await expect(
    asActor(pools.app, f.aUser.actor, (c) => c.query(`update hdt_tickets set status = 'in_progress' where ticket_id = $1`, [dup.ticketId])),
  ).rejects.toThrow(/объединён/);
  expect((await row(dup.ticketId)).status).toBe('closed');
});

test('массовое назначение: отказ по одному обращению не отменяет остальные', async () => {
  const f = await seedTwoOrgs();
  const l1 = staffCtx(f.l1);
  const t1 = await newTicket(f.aUser, 'Первое');
  const t2 = await newTicket(f.aUser, 'Второе');
  const result = await bulkAction(l1, { action: 'assign', numbers: [t1.number, 999_999, t2.number], assigneeId: f.care.userId });
  expect(result).toEqual({ done: [t1.number, t2.number], refused: [{ number: 999_999, code: 'not_found' }] });
  expect((await row(t1.ticketId)).assignee_id).toBe(f.care.userId);
  expect((await row(t2.ticketId)).assignee_id).toBe(f.care.userId);
  // Закрыть как дубль; на вторую линию только с запиской для всех выбранных (FR-LINE-03).
  const t3 = await newTicket(f.aUser, 'Третье');
  expect(await bulkAction(l1, { action: 'duplicate', numbers: [t3.number, f.tickets.aOrg.number], intoNumber: f.tickets.aOrg.number })).toEqual({
    done: [t3.number],
    refused: [{ number: f.tickets.aOrg.number, code: 'merge_refused' }],
  });
  await expect(bulkAction(l1, { action: 'queue', numbers: [t1.number], to: 'l2' })).rejects.toMatchObject({ code: 'invalid_input' });
  expect(
    await bulkAction(l1, { action: 'queue', numbers: [t1.number, t2.number], to: 'l2', reason: 'suspected_bug', checked: 'Проверили у двух пользователей', needed: 'Посмотреть журнал' }),
  ).toEqual({ done: [t1.number, t2.number], refused: [] });
  expect((await row(t2.ticketId)).queue).toBe('l2');
  await expect(bulkAction(l1, { action: 'assign', numbers: Array.from({ length: 101 }, (_, i) => i + 1), assigneeId: null })).rejects.toMatchObject({ code: 'invalid_input' });
});
