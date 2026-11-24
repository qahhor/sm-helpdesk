import { expect, test } from 'vitest';
import { getPlaybook, savePlaybook } from '@/modules/hdr/api';
import { DEFAULT_SLA_POLICIES } from '@/modules/hdr/pref';
import { getTicket, postStaffMessage, getAgentTicket, returnToL1, setPriority, setStatus, takeTicket, transferToL2 } from '@/modules/hdt/api';
import { addWorkingMinutes, TASHKENT_DEFAULT } from '@/modules/hdt/sla';
import { clientCtx, staffCtx, staffWithRole } from './helpers/auth';
import { asActor, pools } from './helpers/db';
import { seedTwoOrgs } from './isolation/fixture';

// Передача между линиями с запиской и памятки первой линии (FR-LINE-03..07, FR-LINE-10, 8.12; план M3, задача 9).

const NOTE = { reason: 'suspected_bug', checked: 'Период один месяц, у другого пользователя отчёт строится', needed: 'Проверить права пользователя на склады' };
const row = (ticketId: string) =>
  pools.root
    .query(`select queue, assignee_id, status, first_response_due_on, resolution_due_on from hdt_tickets where ticket_id = $1`, [ticketId])
    .then((r) => r.rows[0]);
const transfers = (ticketId: string) =>
  pools.root
    .query(
      `select from_line, to_line, reason_code, checked, needed, explanation, checklist, by_user, pickup_due_on, picked_up_on, picked_up_by, created_on
         from hdt_ticket_line_transfers where ticket_id = $1 order by created_on, transfer_id`,
      [ticketId],
    )
    .then((r) => r.rows);
const queueEvents = (ticketId: string) =>
  pools.root
    .query(`select payload, is_internal from hdt_ticket_events where ticket_id = $1 and kind = 'queue' and actor_id is not null order by created_on, event_id`, [ticketId])
    .then((r) => r.rows.filter((e) => e.payload.from !== undefined));
const audit = (ticketId: string) =>
  pools.root.query(`select action from hdc_audit_log where object_id = $1 order by created_on, audit_id`, [ticketId]).then((r) => r.rows.map((x) => x.action as string));

test('передача на вторую линию без причины, проверенного или требуемого невозможна', async () => {
  const f = await seedTwoOrgs();
  const l1 = staffCtx(f.l1);
  const t = f.tickets.aOrg;
  for (const input of [
    { ...NOTE, reason: '' },
    { ...NOTE, reason: 'because' },
    { ...NOTE, checked: '   ' },
    { ...NOTE, needed: '' },
    { reason: NOTE.reason, checked: NOTE.checked },
  ])
    await expect(transferToL2(l1, { number: t.number, ...input }), JSON.stringify(input)).rejects.toMatchObject({ code: 'invalid_input' });
  expect((await row(t.ticketId)).queue).toBe('l1');
  expect(await transfers(t.ticketId)).toEqual([]);
});

test('передача и возврат пишут историю, сроки перед клиентом не меняются', async () => {
  const f = await seedTwoOrgs();
  const l1 = staffCtx(f.l1);
  const l2 = staffCtx(await staffWithRole('agent_l2'));
  const t = f.tickets.aOrg;
  await takeTicket(l1, t.number);
  await setPriority(l1, { number: t.number, priority: 'p2', reason: 'Подтверждаю' });
  const before = await row(t.ticketId);
  await transferToL2(l1, { number: t.number, ...NOTE, checklist: ['Уточнён период и фильтры отчёта'] });
  let r = await row(t.ticketId);
  expect(r).toMatchObject({ queue: 'l2', assignee_id: null });
  expect(r.first_response_due_on.toISOString()).toBe(before.first_response_due_on.toISOString());
  expect(r.resolution_due_on.toISOString()).toBe(before.resolution_due_on.toISOString());
  await expect(transferToL2(l1, { number: t.number, ...NOTE })).rejects.toMatchObject({ code: 'transition_refused' });

  await returnToL1(l2, { number: t.number, explanation: 'Права в порядке, уточните у клиента склад' });
  r = await row(t.ticketId);
  // Возврат приходит тому, кто передавал.
  expect(r).toMatchObject({ queue: 'l1', assignee_id: f.l1.userId });
  expect(r.resolution_due_on.toISOString()).toBe(before.resolution_due_on.toISOString());
  expect((await queueEvents(t.ticketId)).map((e) => [e.payload, e.is_internal])).toEqual([
    [{ from: 'l1', to: 'l2', ...NOTE, checklist: ['Уточнён период и фильтры отчёта'] }, true],
    [{ from: 'l2', to: 'l1', explanation: 'Права в порядке, уточните у клиента склад' }, true],
  ]);
  expect((await transfers(t.ticketId)).map((x) => [x.from_line, x.to_line, x.by_user])).toEqual([
    ['l1', 'l2', f.l1.userId],
    ['l2', 'l1', l2.actor.userId],
  ]);
  expect(await audit(t.ticketId)).toEqual(expect.arrayContaining(['ticket.line_transferred', 'ticket.line_returned']));
  // Сотрудник видит записку передачи на странице обращения.
  const view = await getAgentTicket(l1, t.number);
  expect(view?.line).toBe('l1');
});

test('срок "взять в работу" от момента передачи, отметка при первом действии второй линии', async () => {
  const f = await seedTwoOrgs();
  const l1 = staffCtx(f.l1);
  const l2 = staffCtx(await staffWithRole('agent_l2'));
  const t = f.tickets.aOrg;
  await setPriority(l1, { number: t.number, priority: 'p1', reason: 'Стоит работа склада' });
  await transferToL2(l1, { number: t.number, ...NOTE });
  let [first] = await transfers(t.ticketId);
  expect(first.pickup_due_on.toISOString()).toBe(addWorkingMinutes(first.created_on, DEFAULT_SLA_POLICIES.p1.firstResponseMinutes, TASHKENT_DEFAULT).toISOString());
  expect(first.picked_up_on).toBeNull();
  // Ответ первой линии после передачи вторую линию не отмечает.
  const version = async () => (await getAgentTicket(l1, t.number))?.version ?? '';
  await postStaffMessage(l1, { number: t.number, body: 'Передали специалисту', internal: false, seenVersion: await version() });
  expect((await transfers(t.ticketId))[0].picked_up_on).toBeNull();
  await takeTicket(l2, t.number);
  [first] = await transfers(t.ticketId);
  expect(first.picked_up_on).not.toBeNull();
  expect(first.picked_up_by).toBe(l2.actor.userId);
  const picked = first.picked_up_on.toISOString();
  await postStaffMessage(l2, { number: t.number, body: 'Смотрю права', internal: false, seenVersion: await version() });
  expect((await transfers(t.ticketId))[0].picked_up_on.toISOString()).toBe(picked);

  // Срок из настройки по приоритету (FR-LINE-06), ответ второй линии отмечает передачу.
  await pools.root.query(`insert into hdc_settings (code, value) values ('lines.pickup_minutes', '{"p1": 30}')`);
  await returnToL1(l2, { number: t.number, explanation: 'Нужен повтор у клиента' });
  await transferToL2(l1, { number: t.number, ...NOTE });
  const third = (await transfers(t.ticketId))[2];
  expect(third.pickup_due_on.toISOString()).toBe(addWorkingMinutes(third.created_on, 30, TASHKENT_DEFAULT).toISOString());
  await postStaffMessage(l2, { number: t.number, body: 'Взял', internal: false, seenVersion: await version() });
  expect((await transfers(t.ticketId))[2].picked_up_by).toBe(l2.actor.userId);
});

test('первая линия не возвращает на первую линию, вторая возвращает с пояснением', async () => {
  const f = await seedTwoOrgs();
  const l1 = staffCtx(f.l1);
  const l2 = staffCtx(await staffWithRole('agent_l2'));
  const t = f.tickets.aOrg;
  await expect(returnToL1(l2, { number: t.number, explanation: 'Не наше' })).rejects.toMatchObject({ code: 'transition_refused' });
  await transferToL2(l1, { number: t.number, ...NOTE });
  await expect(returnToL1(l1, { number: t.number, explanation: 'Заберу обратно' })).rejects.toMatchObject({ code: 'forbidden' });
  await expect(returnToL1(l2, { number: t.number, explanation: '  ' })).rejects.toMatchObject({ code: 'invalid_input' });
  // Обращение в разработке при возврате снова "В работе": разработка это вторая линия.
  await setStatus(l2, { number: t.number, to: 'in_progress' });
  await setStatus(l2, { number: t.number, to: 'in_development' });
  await returnToL1(staffCtx(f.care), { number: t.number, explanation: 'Исправлено, проверьте с клиентом' });
  expect(await row(t.ticketId)).toMatchObject({ queue: 'l1', status: 'in_progress' });
});

test('памятку ведут вторая линия, care и admin; первая только читает', async () => {
  const f = await seedTwoOrgs();
  const reports = (await pools.root.query(`insert into hdr_product_modules (code, name) values ('reports', '{"ru": "Отчёты"}') returning module_id`)).rows[0]
    .module_id as string;
  const stock = (await pools.root.query(`insert into hdr_product_modules (code, name) values ('stock', '{"ru": "Склад"}') returning module_id`)).rows[0]
    .module_id as string;
  const body = '- Уточнён период и фильтры отчёта\n- Проверено на другом пользователе';
  await expect(savePlaybook(staffCtx(f.l1), { moduleId: reports, type: 'bug', body })).rejects.toMatchObject({ code: 'forbidden' });
  await expect(savePlaybook(staffCtx(await staffWithRole('product')), { moduleId: reports, type: 'bug', body })).rejects.toMatchObject({ code: 'forbidden' });
  const l2 = staffCtx(await staffWithRole('agent_l2'));
  await savePlaybook(l2, { moduleId: reports, type: 'bug', body });
  expect(await getPlaybook(f.l1.actor, { moduleId: reports, type: 'bug' })).toMatchObject({
    moduleId: reports,
    body,
    items: ['Уточнён период и фильтры отчёта', 'Проверено на другом пользователе'],
  });
  // Общая памятка для типа: для модуля без своей памятки и для обращения без модуля.
  await savePlaybook(staffCtx(f.care), { moduleId: null, type: 'bug', body: '- Версия приложения клиента' });
  expect(await getPlaybook(f.l1.actor, { moduleId: stock, type: 'bug' })).toMatchObject({ moduleId: null, items: ['Версия приложения клиента'] });
  expect(await getPlaybook(f.l1.actor, { moduleId: null, type: 'bug' })).toMatchObject({ moduleId: null });
  expect(await getPlaybook(f.l1.actor, { moduleId: reports, type: 'question' })).toBeNull();
  // Повторное сохранение меняет ту же памятку, ответственным становится сохранивший.
  await savePlaybook(staffCtx(f.adminStaff), { moduleId: reports, type: 'bug', body: '- Только это' });
  const owners = await pools.root.query(`select owner_id, body from hdr_l1_playbooks where module_id = $1`, [reports]);
  expect(owners.rows).toEqual([{ owner_id: f.adminStaff.userId, body: '- Только это' }]);
  await expect(savePlaybook(l2, { moduleId: reports, type: 'bug', body: '   ' })).rejects.toMatchObject({ code: 'invalid_input' });
  expect(await getPlaybook(f.aUser.actor, { moduleId: reports, type: 'bug' })).toBeNull();
});

test('клиент не видит события линии и записки', async () => {
  const f = await seedTwoOrgs();
  const t = f.tickets.aOrg;
  await transferToL2(staffCtx(f.l1), { number: t.number, ...NOTE });
  const view = await getTicket(await clientCtx(f.aUser), t.number);
  expect(view?.events.map((e) => e.kind)).not.toContain('queue');
  expect(JSON.stringify(view)).not.toContain(NOTE.checked);
  expect(JSON.stringify(view)).not.toContain(NOTE.needed);
  expect(await asActor(pools.app, f.aUser.actor, (c) => c.query(`select count(*)::int as n from hdt_ticket_line_transfers`).then((r) => r.rows[0].n))).toBe(0);
});

test('возврат на первую линию из "В разработке" пишет событие смены статуса и сразу будит разбор событий (проверка M8, m5)', async () => {
  const { MemoryJobQueue, setJobQueueForTests } = await import('@/modules/hdc/testing');
  const f = await seedTwoOrgs();
  const l2 = staffCtx(await staffWithRole('agent_l2'));
  const t = f.tickets.aOrg;
  await pools.root.query(`update hdt_tickets set queue = 'l2', status = 'in_development' where ticket_id = $1`, [t.ticketId]);
  const jobs = new MemoryJobQueue();
  setJobQueueForTests(jobs);
  try {
    await returnToL1(l2, { number: t.number, explanation: 'Исправлено, проверьте с клиентом' });
  } finally {
    setJobQueueForTests(null);
  }
  expect((await pools.root.query(`select kind, payload from hdc_domain_events where ticket_id = $1`, [t.ticketId])).rows).toEqual([{ kind: 'status_changed', payload: { from: 'in_development', to: 'in_progress' } }]);
  // Без сигнала событие ждало бы задачу по расписанию до минуты.
  expect(jobs.sent.filter((job) => job.name === 'automation.process')).toHaveLength(1);
});
