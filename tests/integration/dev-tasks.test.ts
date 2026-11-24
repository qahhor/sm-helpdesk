import { beforeEach, expect, test } from 'vitest';
import { getAgentTicket, getTicket, setStatus, takeTicket } from '@/modules/hdt/api';
import { devTrackerMode, readDevTaskForTicket, sendToDevelopment, setDevTaskStatus, unlinkFromDevelopment } from '@/modules/hdw/api/dev-tasks';
import { clientCtx, staffCtx, staffWithRole } from './helpers/auth';
import { asActor, pools } from './helpers/db';
import { type Fixture, seedTwoOrgs, type TicketRef } from './isolation/fixture';

// Передача в разработку, ручной режим (ТЗ 7.9, FR-DEV-01, 02, 05, 06, сценарий S4; план M8, задача 7, решение 12).
// Сотрудник второй линии, Customer Care или администратор вводит номер, ссылку и название задачи: обращение
// привязывается к задаче и получает статус "В разработке" обычным действием сотрудника. Закрытие задачи напоминает
// исполнителям привязанных обращений и статусы обращений не меняет. Клиент о задаче не узнаёт ничего.

let f: Fixture;
let l2: ReturnType<typeof staffCtx>;
let care: ReturnType<typeof staffCtx>;
let l1: ReturnType<typeof staffCtx>;

beforeEach(async () => {
  f = await seedTwoOrgs();
  l2 = staffCtx(await staffWithRole('agent_l2'));
  care = staffCtx(f.care);
  l1 = staffCtx(f.l1);
});

const ticketRow = (ticketId: string) => pools.root.query(`select status, assignee_id, sla_paused_on from hdt_tickets where ticket_id = $1`, [ticketId]).then((r) => r.rows[0]);
const history = (ticketId: string, kind: string) =>
  pools.root.query(`select kind, actor_type, actor_id, payload, is_internal from hdt_ticket_events where ticket_id = $1 and kind = $2 order by created_on, event_id`, [ticketId, kind]).then((r) => r.rows);
const auditOf = (objectId: string, prefix: string) =>
  pools.root.query(`select action, actor_type, actor_id, object_type, diff from hdc_audit_log where object_id = $1 and action like $2 order by created_on, audit_id`, [objectId, `${prefix}%`]).then((r) => r.rows);
const domainEvents = (ticketId: string) => pools.root.query(`select kind, payload, is_by_rule from hdc_domain_events where ticket_id = $1 order by event_id`, [ticketId]).then((r) => r.rows);
const notices = (userId: string) => pools.root.query(`select kind, ticket_id, payload from hdn_notifications where user_id = $1 and kind = 'dev_task_closed' order by created_on`, [userId]).then((r) => r.rows);
const mails = (ticketId: string) =>
  pools.root.query(`select recipient_user_id, channel, payload from hdn_outbox where ticket_id = $1 and template = 'staff_dev_task_closed' order by created_on`, [ticketId]).then((r) => r.rows);
const tasks = () => pools.root.query(`select dev_task_id, tracker, external_id, url, title, status, version, closed_notified_on from hdw_dev_tasks order by created_on, dev_task_id`).then((r) => r.rows);

/** Обращение "В работе" у сотрудника: из него разрешён переход "В разработке". */
async function inProgress(t: TicketRef, by = l2): Promise<void> {
  await takeTicket(by, t.number);
}
const task = (ref = 'DEV-501') => ({ externalId: ref, url: `https://tracker.smartup.example/tasks/${ref}`, title: 'Накладная не проводится при пустом складе' });

test('режим по умолчанию ручной', () => {
  expect(devTrackerMode()).toBe('manual');
});

test('вторая линия передаёт обращение: задача, привязка, статус "В разработке" с историей, журналом и событием для правил', async () => {
  const t = f.tickets.aOrg;
  await inProgress(t);
  expect(await readDevTaskForTicket(l2, t.number)).toBeNull();
  await sendToDevelopment(l2, { ticketNumber: t.number, ...task() });

  expect(await ticketRow(t.ticketId)).toMatchObject({ status: 'in_development', assignee_id: l2.user.id });
  const [row] = await tasks();
  expect(row).toMatchObject({ tracker: 'manual', external_id: 'DEV-501', url: 'https://tracker.smartup.example/tasks/DEV-501', title: 'Накладная не проводится при пустом складе', status: 'todo', version: null, closed_notified_on: null });
  // Статус сменён обычным действием сотрудника: событие истории, видимое клиенту, запись журнала, событие для правил.
  expect((await history(t.ticketId, 'status')).at(-1)).toMatchObject({ actor_type: 'staff', actor_id: l2.user.id, payload: { from: 'in_progress', to: 'in_development' }, is_internal: false });
  expect((await auditOf(t.ticketId, 'ticket.status_changed')).at(-1)).toMatchObject({ actor_id: l2.user.id, diff: { from: 'in_progress', to: 'in_development' } });
  expect((await domainEvents(t.ticketId)).filter((e) => e.kind === 'status_changed').at(-1)).toMatchObject({ payload: { from: 'in_progress', to: 'in_development' }, is_by_rule: false });
  // Клиенту ушло то же письмо о статусе, что при ручной смене.
  expect((await pools.root.query(`select payload ->> 'status' as status from hdn_outbox where ticket_id = $1 and template = 'ticket_status'`, [t.ticketId])).rows).toEqual([{ status: 'in_development' }]);
  // Привязка: внутренняя запись истории и запись журнала без ссылки (в адресе бывают ключи).
  expect(await history(t.ticketId, 'dev_task')).toEqual([
    { kind: 'dev_task', actor_type: 'staff', actor_id: l2.user.id, payload: { action: 'linked', devTaskId: row.dev_task_id, ref: 'DEV-501' }, is_internal: true },
  ]);
  expect(await auditOf(t.ticketId, 'devtask.')).toEqual([
    { action: 'devtask.linked', actor_type: 'staff', actor_id: l2.user.id, object_type: 'ticket', diff: { devTaskId: row.dev_task_id, tracker: 'manual', ref: 'DEV-501', created: true } },
  ]);

  const view = await readDevTaskForTicket(l2, t.number);
  expect(view).toMatchObject({
    task: { devTaskId: row.dev_task_id, tracker: 'manual', externalId: 'DEV-501', url: 'https://tracker.smartup.example/tasks/DEV-501', title: 'Накладная не проводится при пустом складе', status: 'todo', version: null },
    otherTickets: [],
  });
  // Читает любой сотрудник, в том числе первая линия и product.
  expect((await readDevTaskForTicket(l1, t.number))?.task.externalId).toBe('DEV-501');
  expect((await readDevTaskForTicket(staffCtx(await staffWithRole('product')), t.number))?.task.externalId).toBe('DEV-501');
  expect(await readDevTaskForTicket(l2, 999_999_999)).toBeNull();
});

test('первая линия и product передать, отвязать и сменить статус задачи не могут; база отказывает и в обход сервиса', async () => {
  const t = f.tickets.aOrg;
  await inProgress(t, l1);
  const product = staffCtx(await staffWithRole('product'));
  for (const ctx of [l1, product]) await expect(sendToDevelopment(ctx, { ticketNumber: t.number, ...task() })).rejects.toMatchObject({ code: 'forbidden' });
  expect(await tasks()).toEqual([]);
  expect((await ticketRow(t.ticketId)).status).toBe('in_progress');

  await sendToDevelopment(care, { ticketNumber: t.number, ...task() });
  const [row] = await tasks();
  for (const ctx of [l1, product]) {
    await expect(unlinkFromDevelopment(ctx, { ticketNumber: t.number })).rejects.toMatchObject({ code: 'forbidden' });
    await expect(setDevTaskStatus(ctx, { devTaskId: row.dev_task_id, status: 'done' })).rejects.toMatchObject({ code: 'forbidden' });
  }
  // Политики RLS: первая линия не вставляет задачу и привязку и не меняет статус задачи напрямую.
  await expect(asActor(pools.app, f.l1.actor, (c) => c.query(`insert into hdw_dev_tasks (tracker, external_id, url) values ('manual', 'X-1', 'https://t.example/1')`))).rejects.toThrow(/row-level security/);
  await expect(
    asActor(pools.app, f.l1.actor, (c) => c.query(`insert into hdw_dev_task_links (org_id, dev_task_id, ticket_id) values ($1, $2, $3)`, [f.orgA.orgId, row.dev_task_id, f.tickets.aMine.ticketId])),
  ).rejects.toThrow(/row-level security/);
  expect((await asActor(pools.app, f.l1.actor, (c) => c.query(`update hdw_dev_tasks set status = 'done'`))).rowCount).toBe(0);
  expect((await asActor(pools.app, f.l1.actor, (c) => c.query(`delete from hdw_dev_task_links`))).rowCount).toBe(0);
  expect((await tasks())[0].status).toBe('todo');
});

test('второе обращение с тем же номером задачи привязывается к ней же: адрес и название из второй формы не берутся', async () => {
  const a = f.tickets.aOrg;
  const b = f.tickets.bOrg;
  await inProgress(a);
  await inProgress(b, care);
  await sendToDevelopment(l2, { ticketNumber: a.number, ...task() });
  // Номер без учёта регистра и с пробелами по краям.
  await sendToDevelopment(care, { ticketNumber: b.number, externalId: ' dev-501 ', url: 'https://other.example/x', title: 'Другое название' });
  const rows = await tasks();
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ external_id: 'DEV-501', url: 'https://tracker.smartup.example/tasks/DEV-501', title: 'Накладная не проводится при пустом складе' });
  expect((await ticketRow(b.ticketId)).status).toBe('in_development');
  expect((await auditOf(b.ticketId, 'devtask.')).map((x) => x.diff)).toEqual([{ devTaskId: rows[0].dev_task_id, tracker: 'manual', ref: 'DEV-501', created: false }]);
  expect((await readDevTaskForTicket(l2, a.number))?.otherTickets).toEqual([b.number]);
  expect((await readDevTaskForTicket(l2, b.number))?.otherTickets).toEqual([a.number]);
  // У обращения не больше одной задачи.
  await expect(sendToDevelopment(l2, { ticketNumber: a.number, ...task('DEV-777') })).rejects.toMatchObject({ code: 'already_linked' });
  expect(await tasks()).toHaveLength(1);
});

test('обращение уже "В разработке" только привязывается; из "Нового" передать нельзя и ничего не остаётся', async () => {
  const t = f.tickets.aOrg;
  // Статус "Новое": перехода в "В разработке" нет (таблица 7.2).
  await expect(sendToDevelopment(l2, { ticketNumber: t.number, ...task() })).rejects.toMatchObject({ code: 'transition_refused' });
  expect(await tasks()).toEqual([]);
  expect(await history(t.ticketId, 'dev_task')).toEqual([]);
  expect((await ticketRow(t.ticketId)).status).toBe('new');

  await inProgress(t);
  await setStatus(l2, { number: t.number, to: 'in_development' });
  const before = (await history(t.ticketId, 'status')).length;
  await sendToDevelopment(l2, { ticketNumber: t.number, ...task() });
  expect((await history(t.ticketId, 'status')).length).toBe(before);
  expect((await history(t.ticketId, 'dev_task')).map((e) => e.payload.action)).toEqual(['linked']);
  await expect(sendToDevelopment(l2, { ticketNumber: 999_999_999, ...task('DEV-9') })).rejects.toMatchObject({ code: 'not_found' });
});

test('адрес задачи: только https, без учётной записи, не длиннее 500 знаков; javascript: и http вне localhost не принимаются', async () => {
  const t = f.tickets.aOrg;
  await inProgress(t);
  for (const [name, url] of [
    ['http на внешнем узле', 'http://tracker.smartup.example/tasks/1'],
    ['javascript:', 'javascript:alert(1)'],
    ['javascript: с пробелом', ' javascript:alert(1)'],
    ['data:', 'data:text/html,<script>alert(1)</script>'],
    ['без схемы', 'tracker.smartup.example/tasks/1'],
    ['учётная запись в адресе', 'https://user:pass@tracker.smartup.example/tasks/1'],
    ['длиннее 500 знаков', `https://tracker.smartup.example/${'a'.repeat(500)}`],
    ['пустой', ''],
  ] as const)
    await expect(sendToDevelopment(l2, { ticketNumber: t.number, ...task(), url }), name).rejects.toMatchObject({ code: 'invalid_url' });
  for (const [name, bad] of [
    ['пустой номер', { ...task(), externalId: ' ' }],
    ['номер с пробелом', { ...task(), externalId: 'DEV 501' }],
    ['пустое название', { ...task(), title: ' ' }],
    ['лишнее поле', { ...task(), status: 'done' }],
    ['длинное название', { ...task(), title: 'я'.repeat(301) }],
  ] as const)
    await expect(sendToDevelopment(l2, { ticketNumber: t.number, ...bad }), name).rejects.toMatchObject({ code: 'invalid_input' });
  expect(await tasks()).toEqual([]);
  expect((await ticketRow(t.ticketId)).status).toBe('in_progress');
  // Портал в тестах работает на localhost: http допускается только для локального узла, как у вебхуков.
  await sendToDevelopment(l2, { ticketNumber: t.number, ...task(), url: 'http://localhost:3194/tasks/DEV-501' });
  expect((await tasks())[0].url).toBe('http://localhost:3194/tasks/DEV-501');
  // База не принимает иную схему и в обход сервиса.
  await expect(pools.root.query(`insert into hdw_dev_tasks (tracker, external_id, url) values ('manual', 'JS-1', 'javascript:alert(1)')`)).rejects.toThrow(/hdw_dev_tasks_c3/);
});

test('закрытие задачи: напоминание исполнителю каждого обращения "В разработке" один раз, статусы обращений не меняются', async () => {
  const a = f.tickets.aOrg;
  const b = f.tickets.bOrg;
  const c = f.tickets.aMine;
  await inProgress(a);
  await inProgress(b, care);
  await inProgress(c);
  for (const [ctx, t] of [[l2, a], [care, b], [l2, c]] as const) await sendToDevelopment(ctx, { ticketNumber: t.number, ...task() });
  // Третье обращение вернули в работу: о закрытии задачи по нему не напоминают.
  await setStatus(l2, { number: c.number, to: 'in_progress' });
  const [row] = await tasks();

  await setDevTaskStatus(l2, { devTaskId: row.dev_task_id, status: 'in_progress' });
  expect(await notices(l2.user.id)).toEqual([]);
  await setDevTaskStatus(care, { devTaskId: row.dev_task_id, status: 'done', version: '5.14.2' });

  expect((await tasks())[0]).toMatchObject({ status: 'done', version: '5.14.2' });
  expect((await tasks())[0].closed_notified_on).not.toBeNull();
  // Статус обращений не меняется (FR-DEV-05).
  for (const t of [a, b]) expect((await ticketRow(t.ticketId)).status).toBe('in_development');
  expect((await ticketRow(c.ticketId)).status).toBe('in_progress');
  // Исполнителю уведомление в портале и письмо. Тот, кто закрыл задачу, своё напоминание тоже получает.
  expect((await notices(l2.user.id)).map((n) => [n.ticket_id, n.payload])).toEqual([[a.ticketId, { number: a.number, title: a.title, ref: 'DEV-501' }]]);
  expect((await notices(care.user.id)).map((n) => n.ticket_id)).toEqual([b.ticketId]);
  expect((await mails(a.ticketId)).map((m) => [m.recipient_user_id, m.channel])).toEqual([[l2.user.id, 'email']]);
  expect((await mails(b.ticketId)).map((m) => m.recipient_user_id)).toEqual([care.user.id]);
  expect(await mails(c.ticketId)).toEqual([]);
  // В письме номер и тема обращения, как в остальных письмах сотрудникам: описания и переписки нет.
  expect((await mails(a.ticketId))[0].payload).toEqual({ template: 'staff_dev_task_closed', number: a.number, title: a.title, url: `/agent/tickets/SUP-${a.number}`, ref: 'DEV-501' });
  // Внутренняя запись истории на каждом обращении, которому напомнили.
  expect((await history(a.ticketId, 'dev_task')).at(-1)).toMatchObject({ actor_type: 'staff', actor_id: care.user.id, payload: { action: 'closed', ref: 'DEV-501', status: 'done', version: '5.14.2' }, is_internal: true });
  expect((await history(c.ticketId, 'dev_task')).map((e) => e.payload.action)).toEqual(['linked']);
  expect((await auditOf(row.dev_task_id, 'devtask.')).map((x) => [x.action, x.object_type, x.diff])).toEqual([
    ['devtask.status_changed', 'dev_task', { from: 'todo', to: 'in_progress' }],
    ['devtask.status_changed', 'dev_task', { from: 'in_progress', to: 'done', version: '5.14.2' }],
  ]);

  // Повтор того же статуса и смена "готово" на "отменено" второго напоминания не дают.
  await setDevTaskStatus(care, { devTaskId: row.dev_task_id, status: 'done', version: '5.14.2' });
  await setDevTaskStatus(care, { devTaskId: row.dev_task_id, status: 'cancelled' });
  expect(await notices(l2.user.id)).toHaveLength(1);
  expect(await mails(a.ticketId)).toHaveLength(1);
});

test('обращение без исполнителя: о закрытии задачи узнают руководители его линии', async () => {
  const t = f.tickets.aOrg;
  await inProgress(t);
  await sendToDevelopment(l2, { ticketNumber: t.number, ...task() });
  await pools.root.query(`update hdt_tickets set assignee_id = null, queue = 'l2' where ticket_id = $1`, [t.ticketId]);
  const lead = await staffWithRole('agent_l2');
  await pools.root.query(`update hdu_staff set is_lead = true where user_id = $1`, [lead.userId]);
  const [row] = await tasks();
  await setDevTaskStatus(l2, { devTaskId: row.dev_task_id, status: 'cancelled' });
  expect((await notices(lead.userId)).map((n) => n.ticket_id)).toEqual([t.ticketId]);
  expect(await notices(l2.user.id)).toEqual([]);
  expect((await mails(t.ticketId)).map((m) => m.recipient_user_id)).toEqual([lead.userId]);
});

test('отвязать обращение: привязки нет, статус обращения прежний, задача остаётся', async () => {
  const t = f.tickets.aOrg;
  await inProgress(t);
  await sendToDevelopment(l2, { ticketNumber: t.number, ...task() });
  const [row] = await tasks();
  await unlinkFromDevelopment(care, { ticketNumber: t.number });
  expect(await readDevTaskForTicket(l2, t.number)).toBeNull();
  expect((await ticketRow(t.ticketId)).status).toBe('in_development');
  expect(await tasks()).toHaveLength(1);
  expect((await history(t.ticketId, 'dev_task')).map((e) => [e.actor_id, e.payload])).toEqual([
    [l2.user.id, { action: 'linked', devTaskId: row.dev_task_id, ref: 'DEV-501' }],
    [care.user.id, { action: 'unlinked', devTaskId: row.dev_task_id, ref: 'DEV-501' }],
  ]);
  expect((await auditOf(t.ticketId, 'devtask.')).map((x) => x.action)).toEqual(['devtask.linked', 'devtask.unlinked']);
  await expect(unlinkFromDevelopment(care, { ticketNumber: t.number })).rejects.toMatchObject({ code: 'not_found' });
  // Отвязанное обращение о закрытии задачи не узнаёт; привязать его снова можно.
  await setDevTaskStatus(care, { devTaskId: row.dev_task_id, status: 'done' });
  expect(await notices(l2.user.id)).toEqual([]);
  // К закрытой задаче обращение не привязывается: напоминание по ней уже ушло бы в никуда.
  await expect(sendToDevelopment(l2, { ticketNumber: t.number, ...task() })).rejects.toMatchObject({ code: 'task_closed' });
  await setDevTaskStatus(care, { devTaskId: row.dev_task_id, status: 'in_progress' });
  await sendToDevelopment(l2, { ticketNumber: t.number, ...task() });
  // Задачу открыли снова и закрыли: это новое закрытие, напоминание уходит.
  await setDevTaskStatus(care, { devTaskId: row.dev_task_id, status: 'done' });
  expect(await notices(l2.user.id)).toHaveLength(1);
});

test('статус задачи: только из перечня, неизвестная задача не найдена', async () => {
  const t = f.tickets.aOrg;
  await inProgress(t);
  await sendToDevelopment(l2, { ticketNumber: t.number, ...task() });
  const [row] = await tasks();
  for (const bad of [{ devTaskId: row.dev_task_id, status: 'closed' }, { devTaskId: 'x', status: 'done' }, { devTaskId: row.dev_task_id, status: 'done', version: 'в'.repeat(61) }, { devTaskId: row.dev_task_id }])
    await expect(setDevTaskStatus(l2, bad)).rejects.toMatchObject({ code: 'invalid_input' });
  await expect(setDevTaskStatus(l2, { devTaskId: '019a1111-1111-7111-8111-111111111111', status: 'done' })).rejects.toMatchObject({ code: 'not_found' });
});

test('клиент не видит ничего: таблицы задач закрыты, в обращении и его истории нет ни номера, ни ссылки, ни названия задачи', async () => {
  const t = f.tickets.aOrg;
  await inProgress(t);
  await sendToDevelopment(l2, { ticketNumber: t.number, ...task() });
  const [row] = await tasks();
  await setDevTaskStatus(l2, { devTaskId: row.dev_task_id, status: 'done', version: '5.14.2' });
  for (const member of [f.aUser, f.aAdmin]) {
    for (const table of ['hdw_dev_tasks', 'hdw_dev_task_links']) expect((await asActor(pools.app, member.actor, (c) => c.query(`select * from ${table}`))).rows).toEqual([]);
    await expect(asActor(pools.app, member.actor, (c) => c.query(`insert into hdw_dev_tasks (tracker, external_id, url) values ('manual', 'C-1', 'https://t.example/1')`))).rejects.toThrow(/row-level security/);
    expect((await asActor(pools.app, member.actor, (c) => c.query(`select kind from hdt_ticket_events where ticket_id = $1 and kind = 'dev_task'`, [t.ticketId]))).rows).toEqual([]);
  }
  const view = await getTicket(await clientCtx(f.aUser), `SUP-${t.number}`);
  expect(view?.status).toBe('in_development');
  const json = JSON.stringify(view);
  for (const secret of ['DEV-501', 'tracker.smartup.example', 'Накладная не проводится при пустом складе', 'dev_task', '5.14.2', row.dev_task_id]) expect(json).not.toContain(secret);
  // Уведомлений о задаче у клиента нет.
  expect((await pools.root.query(`select 1 from hdn_notifications where user_id = any($1) and kind = 'dev_task_closed'`, [[f.aUser.userId, f.aAdmin.userId]])).rows).toEqual([]);
  // Сотрудник запись истории видит.
  const agent = await getAgentTicket(l2, t.number);
  expect(agent?.timeline.filter((e) => e.type === 'event' && e.kind === 'dev_task').map((e) => (e.type === 'event' ? e.payload.action : null))).toEqual(['linked', 'closed']);
});
