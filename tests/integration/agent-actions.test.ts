import { expect, test } from 'vitest';
import { assignTicket, setPriority, setStatus, setTicketModule, setTicketType, snoozeTicket, takeTicket } from '@/modules/hdt/api';
import { listAssignableStaff } from '@/modules/hdu/api';
import { staffCtx, staffWithRole } from './helpers/auth';
import { pools } from './helpers/db';
import { seedTwoOrgs } from './isolation/fixture';

// Действия сотрудника с обращением (FR-AG-02, 04, 09, 13, FR-SLA-03, раздел 7.2, UX-A-11; план M3, задача 7).

const row = (ticketId: string) =>
  pools.root
    .query(
      `select status, assignee_id, priority, priority_confirmed, type, module_id, resolution_type, resolved_version, resolved_on, closed_on, snoozed_until,
              first_response_due_on, resolution_due_on, sla_paused_on from hdt_tickets where ticket_id = $1`,
      [ticketId],
    )
    .then((r) => r.rows[0]);
const events = (ticketId: string, kind: string) =>
  pools.root
    .query(`select payload, is_internal, actor_id from hdt_ticket_events where ticket_id = $1 and kind = $2 order by created_on, event_id`, [ticketId, kind])
    .then((r) => r.rows);
const audit = (ticketId: string) =>
  pools.root.query(`select action from hdc_audit_log where object_id = $1 order by created_on, audit_id`, [ticketId]).then((r) => r.rows.map((x) => x.action as string));

test('запрещённый переход статуса отклоняется: new -> resolved, closed -> waiting_customer', async () => {
  const f = await seedTwoOrgs();
  const l1 = staffCtx(f.l1);
  const t = f.tickets.aOrg;
  await expect(setStatus(l1, { number: t.number, to: 'resolved', resolution: 'solved' })).rejects.toMatchObject({ code: 'transition_refused' });
  await pools.root.query(`update hdt_tickets set status = 'closed' where ticket_id = $1`, [t.ticketId]);
  await expect(setStatus(l1, { number: t.number, to: 'waiting_customer' })).rejects.toMatchObject({ code: 'transition_refused' });
  expect((await row(t.ticketId)).status).toBe('closed');
  await expect(setStatus(l1, { number: t.number, to: 'archived' })).rejects.toMatchObject({ code: 'invalid_input' });
});

test('первая линия не ставит "В разработке", вторая ставит', async () => {
  const f = await seedTwoOrgs();
  const t = f.tickets.aOrg;
  await pools.root.query(`update hdt_tickets set status = 'in_progress' where ticket_id = $1`, [t.ticketId]);
  await expect(setStatus(staffCtx(f.l1), { number: t.number, to: 'in_development' })).rejects.toMatchObject({ code: 'forbidden' });
  const l2 = await staffWithRole('agent_l2');
  await setStatus(staffCtx(l2), { number: t.number, to: 'in_development' });
  expect((await row(t.ticketId)).status).toBe('in_development');
});

test('"Решено" без итога отклоняется, "исправлено в версии" требует номер', async () => {
  const f = await seedTwoOrgs();
  const l1 = staffCtx(f.l1);
  const t = f.tickets.aOrg;
  await pools.root.query(`update hdt_tickets set status = 'in_progress' where ticket_id = $1`, [t.ticketId]);
  await expect(setStatus(l1, { number: t.number, to: 'resolved' })).rejects.toMatchObject({ code: 'resolution_required' });
  await expect(setStatus(l1, { number: t.number, to: 'resolved', resolution: 'fixed_in_version' })).rejects.toMatchObject({ code: 'resolution_required' });
  await setStatus(l1, { number: t.number, to: 'resolved', resolution: 'fixed_in_version', version: '5.12.3' });
  const r = await row(t.ticketId);
  expect(r).toMatchObject({ status: 'resolved', resolution_type: 'fixed_in_version', resolved_version: '5.12.3' });
  expect(r.resolved_on).not.toBeNull();
  expect(await events(t.ticketId, 'status')).toEqual([{ payload: { from: 'in_progress', to: 'resolved', resolution: 'fixed_in_version' }, is_internal: false, actor_id: f.l1.userId }]);
});

test('смена приоритета без причины отклоняется, с причиной пересчитывает сроки и пишет событие и аудит', async () => {
  const f = await seedTwoOrgs();
  const l1 = staffCtx(f.l1);
  const t = f.tickets.aOrg;
  await expect(setPriority(l1, { number: t.number, priority: 'p1', reason: '  ' })).rejects.toMatchObject({ code: 'reason_required' });
  await setPriority(l1, { number: t.number, priority: 'p1', reason: 'Не проводятся все накладные' });
  const r = await row(t.ticketId);
  expect(r).toMatchObject({ priority: 'p1', priority_confirmed: true });
  expect(r.first_response_due_on).not.toBeNull();
  expect(await events(t.ticketId, 'priority')).toEqual([{ payload: { from: 'p2', to: 'p1', reason: 'Не проводятся все накладные' }, is_internal: true, actor_id: f.l1.userId }]);
  expect(await audit(t.ticketId)).toContain('ticket.priority_changed');
});

test('двое нажали "Взять себе" одновременно: взял один, второй получил already_taken', async () => {
  const f = await seedTwoOrgs();
  const t = f.tickets.aOrg;
  const results = await Promise.allSettled([takeTicket(staffCtx(f.l1), t.number), takeTicket(staffCtx(f.care), t.number)]);
  expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  const refused = results.find((r) => r.status === 'rejected');
  expect(refused && refused.status === 'rejected' && refused.reason).toMatchObject({ code: 'already_taken' });
  const r = await row(t.ticketId);
  expect(r.status).toBe('in_progress');
  expect([f.l1.userId, f.care.userId]).toContain(r.assignee_id);
  // Взять своё повторно можно: ничего не меняется и истории не прибавляется.
  const winner = r.assignee_id === f.l1.userId ? staffCtx(f.l1) : staffCtx(f.care);
  await takeTicket(winner, t.number);
  expect(await events(t.ticketId, 'assignee')).toHaveLength(1);
  expect((await events(t.ticketId, 'status')).map((e) => e.payload)).toEqual([{ from: 'new', to: 'in_progress' }]);
});

test('назначить можно только сотрудника, который ведёт обращения', async () => {
  const f = await seedTwoOrgs();
  const l1 = staffCtx(f.l1);
  const t = f.tickets.aOrg;
  const product = await staffWithRole('product');
  const options = await listAssignableStaff(l1);
  expect(options.map((o) => o.userId)).toEqual(expect.arrayContaining([f.l1.userId, f.care.userId, f.adminStaff.userId]));
  expect(options.map((o) => o.userId)).not.toContain(product.userId);
  // Роль product только читает: список для назначения ей не нужен.
  expect(await listAssignableStaff(staffCtx(product))).toEqual([]);
  await expect(assignTicket(l1, { number: t.number, assigneeId: product.userId })).rejects.toMatchObject({ code: 'invalid_input' });
  await expect(assignTicket(l1, { number: t.number, assigneeId: f.aUser.userId })).rejects.toMatchObject({ code: 'invalid_input' });
  await assignTicket(l1, { number: t.number, assigneeId: f.care.userId });
  expect((await row(t.ticketId)).assignee_id).toBe(f.care.userId);
  await assignTicket(l1, { number: t.number, assigneeId: null });
  expect((await row(t.ticketId)).assignee_id).toBeNull();
  expect((await events(t.ticketId, 'assignee')).every((e) => e.is_internal)).toBe(true);
});

test('тип и модуль меняются с событием и аудитом; неизвестный модуль отклоняется', async () => {
  const f = await seedTwoOrgs();
  const l1 = staffCtx(f.l1);
  const t = f.tickets.aOrg;
  const moduleId = (await pools.root.query(`insert into hdr_product_modules (code, name) values ('warehouse', '{"ru": "Склад"}') returning module_id`)).rows[0]
    .module_id as string;
  await setTicketType(l1, { number: t.number, type: 'question' });
  await setTicketModule(l1, { number: t.number, moduleId });
  expect(await row(t.ticketId)).toMatchObject({ type: 'question', module_id: moduleId });
  await expect(setTicketModule(l1, { number: t.number, moduleId: '0192d2a4-0000-7000-8000-000000000001' })).rejects.toMatchObject({ code: 'invalid_input' });
  expect(await audit(t.ticketId)).toEqual(expect.arrayContaining(['ticket.type_changed', 'ticket.module_changed']));
  expect((await events(t.ticketId, 'type')).map((e) => e.payload)).toEqual([{ from: 'bug', to: 'question' }]);
});

test('отложить: в прошлое нельзя, сроки не останавливаются, снять отложение можно', async () => {
  const f = await seedTwoOrgs();
  const l1 = staffCtx(f.l1);
  const t = f.tickets.aOrg;
  await expect(snoozeTicket(l1, { number: t.number, until: new Date(Date.now() - 60_000).toISOString() })).rejects.toMatchObject({ code: 'invalid_input' });
  await setPriority(l1, { number: t.number, priority: 'p2', reason: 'Подтверждаю' });
  const before = await row(t.ticketId);
  const until = new Date(Date.now() + 3_600_000);
  await snoozeTicket(l1, { number: t.number, until: until.toISOString() });
  const after = await row(t.ticketId);
  expect(after.snoozed_until?.toISOString()).toBe(until.toISOString());
  expect(after.resolution_due_on?.toISOString()).toBe(before.resolution_due_on?.toISOString());
  expect(after.sla_paused_on).toBeNull();
  await snoozeTicket(l1, { number: t.number, until: null });
  expect((await row(t.ticketId)).snoozed_until).toBeNull();
});

test('статус "Ждём вашего ответа" ставит паузу, возврат в работу снимает', async () => {
  const f = await seedTwoOrgs();
  const l1 = staffCtx(f.l1);
  const t = f.tickets.aOrg;
  await takeTicket(l1, t.number);
  await setStatus(l1, { number: t.number, to: 'waiting_customer' });
  expect((await row(t.ticketId)).sla_paused_on).not.toBeNull();
  await setStatus(l1, { number: t.number, to: 'in_progress' });
  expect((await row(t.ticketId)).sla_paused_on).toBeNull();
});

test('каждое действие пишет событие и аудит в той же транзакции; product получает forbidden на любое действие', async () => {
  const f = await seedTwoOrgs();
  const t = f.tickets.aOrg;
  await takeTicket(staffCtx(f.l1), t.number);
  expect(await audit(t.ticketId)).toEqual(['ticket.assigned', 'ticket.status_changed']);
  const product = staffCtx(await staffWithRole('product'));
  for (const action of [
    () => takeTicket(product, t.number),
    () => setStatus(product, { number: t.number, to: 'waiting_customer' }),
    () => setPriority(product, { number: t.number, priority: 'p1', reason: 'x' }),
    () => setTicketType(product, { number: t.number, type: 'question' }),
    () => snoozeTicket(product, { number: t.number, until: new Date(Date.now() + 3_600_000).toISOString() }),
    () => assignTicket(product, { number: t.number, assigneeId: null }),
  ])
    await expect(action()).rejects.toMatchObject({ code: 'forbidden' });
});
