import { beforeEach, expect, test } from 'vitest';
import { processEvents } from '@/modules/hdc/api';
import { createTicket, getAgentTicket, getTicket, postStaffMessage, replyToTicket, setPriority } from '@/modules/hdt/api';
import { cleanupRuleRuns, handleRuleEvent, newRuleRun, runNoActivityRules, setWebhookDeliverer } from '@/modules/hdw/api/engine';
import { deleteRule, dryRunRule, moveRule, saveRule, setRuleEnabled } from '@/modules/hdw/api/rules';
import { clientCtx, staffCtx, staffWithRole } from './helpers/auth';
import { asActor, pools } from './helpers/db';
import { type Fixture, seedTwoOrgs, type TicketRef } from './isolation/fixture';

// Применение правил автоматизации (ТЗ 7.17, FR-AUTO-04, 06, 07, 09, 11; план M8, задача 3, решения 3-5). Событие
// обращения разбирает задача automation.process: правила события применяются в транзакции события. Каждое
// срабатывание пишет строку журнала срабатываний, внутреннюю запись истории и запись журнала аудита.

const SYSTEM = { type: 'system', job: 'automation.process' } as const;
const HOUR = 3_600_000;
let f: Fixture;
let admin: ReturnType<typeof staffCtx>;

beforeEach(async () => {
  f = await seedTwoOrgs();
  admin = staffCtx(f.adminStaff);
  setWebhookDeliverer(null);
});

type RuleInput = { name?: string; event?: string; hours?: number; conditions?: unknown[]; match?: 'all' | 'any'; actions: unknown[]; isStop?: boolean };
/** Правило через слой api, сразу включённое. */
async function rule(input: RuleInput): Promise<string> {
  const { ruleId } = await saveRule(admin, {
    name: input.name ?? 'Правило теста',
    event: input.event ?? 'client_replied',
    ...(input.hours !== undefined ? { hours: input.hours } : {}),
    conditions: { match: input.match ?? 'all', items: input.conditions ?? [] },
    actions: input.actions,
    isStop: input.isStop ?? false,
  });
  await setRuleEnabled(admin, { ruleId, enabled: true });
  return ruleId;
}
/** Событие строкой под суперпользователем, как его записало бы действие над обращением. */
const emit = (ticket: TicketRef, orgId: string, kind = 'client_replied', byRule = false) =>
  pools.root
    .query(`insert into hdc_domain_events (org_id, ticket_id, kind, is_by_rule) values ($1, $2, $3, $4) returning event_id`, [orgId, ticket.ticketId, kind, byRule])
    .then((r) => r.rows[0].event_id as string);
/** Разбор очереди событий правилами, как в фоновом процессе. */
async function drain(now?: Date) {
  const run = newRuleRun(now ? { now: () => now } : {});
  const result = await processEvents(SYSTEM, (tx, event) => handleRuleEvent(tx, event, run));
  return { ...result, run };
}
const fire = async (ticket: TicketRef, orgId: string = f.orgA.orgId, kind = 'client_replied') => {
  const eventId = await emit(ticket, orgId, kind);
  await drain();
  return eventId;
};

type RunRow = { run_id: string; rule_id: string; ticket_id: string; org_id: string; event_id: string | null; result: string; actions_done: { action: string; ok: boolean; detail?: string; from?: string | null; to?: string | null; unchanged?: boolean }[]; is_dry_run: boolean; marker: string | null };
const runs = (ruleId?: string) =>
  pools.root.query<RunRow>(`select * from hdw_rule_runs ${ruleId ? 'where rule_id = $1' : ''} order by run_id`, ruleId ? [ruleId] : []).then((r) => r.rows);
const ticketRow = (ticketId: string) => pools.root.query(`select * from hdt_tickets where ticket_id = $1`, [ticketId]).then((r) => r.rows[0]);
const history = (ticketId: string, kind?: string) =>
  pools.root
    .query(`select kind, actor_type, actor_id, payload, is_internal from hdt_ticket_events where ticket_id = $1 and kind <> 'created' ${kind ? `and kind = '${kind}'` : ''} order by created_on, event_id`, [ticketId])
    .then((r) => r.rows);
const auditOf = (objectId: string) =>
  pools.root.query(`select action, actor_type, diff from hdc_audit_log where object_id = $1 order by created_on, audit_id`, [objectId]).then((r) => r.rows);
const messagesOf = (ticketId: string) =>
  pools.root.query(`select message_id, author_type, author_id, body, is_internal, is_auto from hdt_ticket_messages where ticket_id = $1 order by created_on, message_id`, [ticketId]).then((r) => r.rows);
const tag = (name: string) => pools.root.query(`insert into hdr_tags (name) values ($1) returning tag_id`, [name]).then((r) => r.rows[0].tag_id as string);
const ENDPOINT = '019a1111-1111-7111-8111-111111111111';
/** Адрес вебхука в списке администратора: без него правило с действием "вызвать вебхук" не сохраняется. */
const endpoint = () => pools.root.query(`insert into hdw_webhook_endpoints (endpoint_id, name, url) values ($1, 'Учёт', 'https://hooks.partner.example/in')`, [ENDPOINT]);
const template = (body: Record<string, string>, enabled = true) =>
  pools.root
    .query(`insert into hdr_reply_templates (shortcut, title, body, is_enabled) values ($1, 'Запрос версии', $2, $3) returning template_id`, [`t${Math.random().toString(36).slice(2, 10)}`, JSON.stringify(body), enabled])
    .then((r) => r.rows[0].template_id as string);

test('правило выполняет действия над обращением события: приоритет, тег, заметка, исполнитель, отложить, статус', async () => {
  const t = f.tickets.aOrg;
  const tagId = await tag('VIP');
  const ruleId = await rule({
    name: 'Срочное от ACME',
    conditions: [{ field: 'priority', op: 'is', values: ['p2'] }],
    actions: [
      { action: 'set_priority', priority: 'p1' },
      { action: 'add_tag', tagId },
      { action: 'add_note', text: 'Проверить оплату клиента' },
      { action: 'assign', userId: f.l1.userId },
      { action: 'snooze', hours: 24 },
      { action: 'set_status', status: 'in_progress' },
    ],
  });
  const before = Date.now();
  const eventId = await fire(t);

  const row = await ticketRow(t.ticketId);
  expect(row).toMatchObject({ priority: 'p1', assignee_id: f.l1.userId, status: 'in_progress', priority_confirmed: false });
  expect(new Date(row.snoozed_until).getTime()).toBeGreaterThanOrEqual(before + 24 * HOUR - 1000);
  expect(new Date(row.snoozed_until).getTime()).toBeLessThanOrEqual(Date.now() + 24 * HOUR);
  expect((await pools.root.query(`select added_by from hdt_ticket_tags where ticket_id = $1 and tag_id = $2`, [t.ticketId, tagId])).rows).toEqual([{ added_by: null }]);

  // Журнал срабатываний: одна строка с действиями по порядку, прежним и новым значением.
  const [run, ...rest] = await runs();
  expect(rest).toEqual([]);
  expect(run).toMatchObject({ rule_id: ruleId, ticket_id: t.ticketId, org_id: f.orgA.orgId, event_id: eventId, result: 'applied', is_dry_run: false, marker: null });
  expect(run?.actions_done.map((item) => [item.action, item.ok, item.from ?? null, item.to ?? null])).toEqual([
    ['set_priority', true, 'p2', 'p1'],
    ['add_tag', true, null, 'VIP'],
    ['add_note', true, null, null],
    ['assign', true, null, f.l1.name],
    ['snooze', true, null, run?.actions_done[4]?.to],
    ['set_status', true, 'new', 'in_progress'],
  ]);

  // История обращения: события действий от имени системы с отметкой правила и одна запись "сработало правило".
  const events = await history(t.ticketId);
  expect(events.filter((e) => e.kind !== 'rule' && e.kind !== 'queue').map((e) => [e.kind, e.actor_type, e.actor_id, e.is_internal, e.payload.byRule])).toEqual([
    ['priority', 'system', null, true, true],
    ['tag', 'system', null, true, true],
    ['assignee', 'system', null, true, true],
    ['snooze', 'system', null, true, true],
    ['status', 'system', null, false, true],
  ]);
  const [ruleEvent] = events.filter((e) => e.kind === 'rule');
  expect(ruleEvent).toMatchObject({ actor_type: 'system', is_internal: true, payload: { ruleId, ruleName: 'Срочное от ACME' } });
  expect(ruleEvent.payload.actions).toEqual(run?.actions_done);

  // Журнал аудита: те же действия, что у сотрудника, и запись о срабатывании, все от системы.
  const audit = await auditOf(t.ticketId);
  expect(audit.map((a) => a.action)).toEqual(['ticket.priority_changed', 'ticket.tag_added', 'ticket.assigned', 'ticket.snoozed', 'ticket.status_changed', 'rule.applied']);
  expect(new Set(audit.map((a) => a.actor_type))).toEqual(new Set(['system']));
  expect(audit.at(-1)?.diff).toMatchObject({ ruleId, ruleName: 'Срочное от ACME', result: 'applied' });

  // Заметка правила: внутренняя, от системы, с отметкой "автоматически". Клиент её не видит.
  const notes = (await messagesOf(t.ticketId)).filter((m) => m.is_auto);
  expect(notes).toMatchObject([{ author_type: 'system', author_id: null, body: 'Проверить оплату клиента', is_internal: true }]);
  const seen = await getTicket(await clientCtx(f.aUser), t.number);
  expect(seen?.messages.map((m) => m.body)).not.toContain('Проверить оплату клиента');
  expect(await asActor(pools.app, f.aUser.actor, (c) => c.query(`select 1 from hdt_ticket_messages where is_auto`)).then((r) => r.rowCount)).toBe(0);
  // Клиент видит смену статуса и не видит ни записи о правиле, ни внутренних событий.
  expect(seen?.events.map((e) => e.kind)).toEqual(['created', 'status']);

  // События предметной области от действий помечены как порождённые правилом: правила на них не срабатывают.
  const emitted = (await pools.root.query(`select kind, is_by_rule, processed_on from hdc_domain_events where event_id <> $1 order by event_id`, [eventId])).rows;
  expect(emitted.map((e) => [e.kind, e.is_by_rule, e.processed_on !== null])).toEqual([
    ['priority_changed', true, true],
    ['status_changed', true, true],
  ]);
  // Рабочее место показывает одну запись о правиле вместо событий его действий.
  const view = await getAgentTicket(staffCtx(f.l1), t.number);
  const shown = view?.timeline.filter((entry) => entry.type === 'event').map((entry) => (entry.type === 'event' ? entry.kind : ''));
  expect(shown).toEqual(['queue', 'rule']);
  expect(view?.timeline.find((entry) => entry.type === 'message' && entry.body === 'Проверить оплату клиента')).toMatchObject({ isAuto: true, isInternal: true });
});

test('смена очереди и снятие тега; повтор ничего не меняет и записывается как "без изменений"', async () => {
  const t = f.tickets.aOrg;
  const tagId = await tag('Оплата');
  await pools.root.query(`insert into hdt_ticket_tags (org_id, ticket_id, tag_id) values ($1, $2, $3)`, [f.orgA.orgId, t.ticketId, tagId]);
  await pools.root.query(`update hdt_tickets set assignee_id = $2 where ticket_id = $1`, [t.ticketId, f.l1.userId]);
  const ruleId = await rule({ actions: [{ action: 'set_queue', queue: 'l2' }, { action: 'remove_tag', tagId }] });
  await fire(t);
  expect(await ticketRow(t.ticketId)).toMatchObject({ queue: 'l2', assignee_id: null });
  expect((await pools.root.query(`select 1 from hdt_ticket_tags where ticket_id = $1`, [t.ticketId])).rowCount).toBe(0);
  expect((await history(t.ticketId)).filter((e) => e.payload.byRule).map((e) => [e.kind, 'to' in e.payload ? e.payload.to : e.payload.action])).toEqual([
    ['assignee', null],
    ['queue', 'l2'],
    ['tag', 'removed'],
  ]);
  expect((await auditOf(t.ticketId)).map((a) => a.action)).toEqual(['ticket.assigned', 'ticket.line_transferred', 'ticket.tag_removed', 'rule.applied']);
  // Строку передачи с автором и сроком "взять в работу" правило не пишет: у такой передачи нет сотрудника.
  expect((await pools.root.query(`select 1 from hdt_ticket_line_transfers where ticket_id = $1`, [t.ticketId])).rowCount).toBe(0);

  await fire(t);
  const all = await runs(ruleId);
  expect(all.map((r) => r.result)).toEqual(['applied', 'applied']);
  expect(all[1]?.actions_done).toEqual([
    { action: 'set_queue', ok: true, from: 'l2', to: 'l2', unchanged: true },
    { action: 'remove_tag', ok: true, from: null, to: null, unchanged: true },
  ]);
  expect((await history(t.ticketId, 'queue')).filter((e) => e.payload.byRule)).toHaveLength(1);
});

test('ответ по шаблону: публичное сообщение системы с отметкой "автоматический", на языке обращения, клиент его видит', async () => {
  const t = f.tickets.aOrg;
  const templateId = await template({ ru: 'Здравствуйте! Пришлите, пожалуйста, версию и скриншот.', uz: 'Assalomu alaykum! Versiya va skrinshot yuboring.' });
  const ruleId = await rule({ event: 'ticket_created', actions: [{ action: 'reply_template', templateId }] });
  const eventId = await fire(t, f.orgA.orgId, 'ticket_created');

  const auto = (await messagesOf(t.ticketId)).filter((m) => m.is_auto);
  expect(auto).toMatchObject([{ author_type: 'system', author_id: null, is_internal: false, body: 'Здравствуйте! Пришлите, пожалуйста, версию и скриншот.' }]);
  // Автоматический ответ не считается первым ответом сотрудника: срок первого ответа идёт, статус и исполнитель прежние.
  expect(await ticketRow(t.ticketId)).toMatchObject({ first_responded_on: null, status: 'new', assignee_id: null });
  // Клиент видит ответ с отметкой; автор для него "Поддержка".
  const seen = await getTicket(await clientCtx(f.aUser), t.number);
  expect(seen?.messages.find((m) => m.messageId === auto[0].message_id)).toMatchObject({ isAuto: true, authorType: 'system', isMine: false });
  expect(seen?.messages.filter((m) => !m.isAuto).every((m) => m.isAuto === false)).toBe(true);
  expect((await getAgentTicket(staffCtx(f.l1), t.number))?.timeline.find((e) => e.type === 'message' && e.id === auto[0].message_id)).toMatchObject({ isAuto: true, isInternal: false });
  // Клиенту уходит то же письмо и уведомление, что об ответе сотрудника.
  const mail = (await pools.root.query(`select template, recipient_user_id, message_id from hdn_outbox where ticket_id = $1 and status = 'queued'`, [t.ticketId])).rows;
  expect(mail).toEqual([{ template: 'ticket_reply', recipient_user_id: f.aUser.userId, message_id: auto[0].message_id }]);
  expect((await pools.root.query(`select 1 from hdn_notifications where ticket_id = $1 and user_id = $2 and kind = 'ticket_reply' and read_on is null and created_on > now() - interval '1 minute'`, [t.ticketId, f.aUser.userId])).rowCount).toBe(2);
  // Событие "сотрудник ответил" от автоответа помечено правилом.
  expect((await pools.root.query(`select kind, is_by_rule, payload from hdc_domain_events where event_id <> $1`, [eventId])).rows).toEqual([
    { kind: 'staff_replied', is_by_rule: true, payload: { messageId: auto[0].message_id, auto: true } },
  ]);
  expect((await runs(ruleId))[0]?.actions_done).toEqual([{ action: 'reply_template', ok: true, to: 'Запрос версии' }]);

  // Язык обращения: узбекский текст; перевода нет: русский (как у шаблонов в поле ответа).
  await pools.root.query(`update hdt_tickets set locale = 'uz' where ticket_id = $1`, [f.tickets.aMine.ticketId]);
  await pools.root.query(`update hdt_tickets set locale = 'en' where ticket_id = $1`, [f.tickets.aPrivate.ticketId]);
  await fire(f.tickets.aMine, f.orgA.orgId, 'ticket_created');
  await fire(f.tickets.aPrivate, f.orgA.orgId, 'ticket_created');
  expect((await messagesOf(f.tickets.aMine.ticketId)).find((m) => m.is_auto)?.body).toBe('Assalomu alaykum! Versiya va skrinshot yuboring.');
  expect((await messagesOf(f.tickets.aPrivate.ticketId)).find((m) => m.is_auto)?.body).toBe('Здравствуйте! Пришлите, пожалуйста, версию и скриншот.');
});

test('отметку "автоматический" ставит только система: клиент и сотрудник такое сообщение записать не могут', async () => {
  const t = f.tickets.aOrg;
  const insert = (actor: Parameters<typeof asActor>[1], authorType: string, userId: string) =>
    asActor(pools.app, actor, (c) =>
      c.query(`insert into hdt_ticket_messages (org_id, ticket_id, author_id, author_type, body, is_auto) values ($1, $2, $3, $4, 'Подделка', true)`, [f.orgA.orgId, t.ticketId, userId, authorType]),
    );
  await expect(insert(f.aUser.actor, 'client', f.aUser.userId)).rejects.toThrow(/hdt_ticket_messages_c4/);
  await expect(insert(f.l1.actor, 'staff', f.l1.userId)).rejects.toThrow(/hdt_ticket_messages_c4/);
});

test('уведомление правила: сотруднику и роли в портале и письмом, дежурным без темы обращения', async () => {
  const t = f.tickets.aOrg;
  const ruleId = await rule({
    name: 'Сообщить о срочном',
    actions: [
      { action: 'notify', target: { kind: 'user', userId: f.l1.userId } },
      { action: 'notify', target: { kind: 'role', role: 'care' } },
      { action: 'notify', target: { kind: 'oncall' } },
      { action: 'notify', target: { kind: 'role', role: 'product' } },
    ],
  });
  await fire(t);
  const notices = (await pools.root.query(`select user_id, org_id, ticket_id, payload from hdn_notifications where kind = 'rule' order by user_id`)).rows;
  expect(notices).toHaveLength(2);
  expect(new Set(notices.map((n) => n.user_id))).toEqual(new Set([f.l1.userId, f.care.userId]));
  for (const n of notices) expect(n).toMatchObject({ org_id: f.orgA.orgId, ticket_id: t.ticketId, payload: { number: t.number, title: t.title, rule: 'Сообщить о срочном' } });
  const staffMail = (await pools.root.query(`select recipient_user_id, payload from hdn_outbox where template = 'staff_rule' order by recipient_user_id`)).rows;
  expect(new Set(staffMail.map((m) => m.recipient_user_id))).toEqual(new Set([f.l1.userId, f.care.userId]));
  expect(staffMail[0].payload).toEqual({ template: 'staff_rule', rule: 'Сообщить о срочном', number: t.number, title: t.title, url: `/agent/tickets/SUP-${t.number}` });
  const oncall = (await pools.root.query(`select channel, recipient_kind, ticket_id, payload from hdn_outbox where template = 'oncall_rule' order by channel`)).rows;
  expect(oncall.map((m) => [m.channel, m.recipient_kind, m.ticket_id])).toEqual([
    ['email', 'oncall', t.ticketId],
    ['telegram', 'oncall', t.ticketId],
  ]);
  // Дежурным только номер, название правила и ссылка: темы обращения (текста клиента) в данных нет.
  for (const m of oncall) expect(m.payload).toEqual({ template: 'oncall_rule', rule: 'Сообщить о срочном', number: t.number, url: `/agent/tickets/SUP-${t.number}` });
  // Роль без действующих сотрудников: действие не выполнено, остальные выполнены.
  const [run] = await runs(ruleId);
  expect(run?.result).toBe('partial');
  expect(run?.actions_done).toEqual([
    { action: 'notify', ok: true, to: f.l1.name },
    { action: 'notify', ok: true, to: 'care' },
    { action: 'notify', ok: true, to: 'oncall' },
    { action: 'notify', ok: false, detail: 'no_recipients' },
  ]);
});

test('права: статус вне разрешённых переходов правило не ставит, отказ записан, остальные действия выполнены', async () => {
  const t = f.tickets.aOrg;
  const ruleId = await rule({ actions: [{ action: 'set_status', status: 'closed' }, { action: 'set_status', status: 'in_development' }, { action: 'add_note', text: 'Заметка после отказа' }] });
  await fire(t);
  // Из "Новое" нельзя ни закрыть, ни передать в разработку (раздел 7.2).
  expect(await ticketRow(t.ticketId)).toMatchObject({ status: 'new', closed_on: null });
  const [run] = await runs(ruleId);
  expect(run?.result).toBe('partial');
  expect(run?.actions_done).toEqual([
    { action: 'set_status', ok: false, detail: 'transition_refused' },
    { action: 'set_status', ok: false, detail: 'transition_refused' },
    { action: 'add_note', ok: true },
  ]);
  expect(await history(t.ticketId, 'status')).toEqual([]);
  expect((await messagesOf(t.ticketId)).filter((m) => m.is_auto)).toHaveLength(1);
  expect((await auditOf(t.ticketId)).map((a) => a.action)).toEqual(['rule.applied']);

  // Разрешённый переход проходит; объединённое обращение правило не открывает.
  await pools.root.query(`update hdt_tickets set status = 'waiting_customer' where ticket_id = $1`, [t.ticketId]);
  await fire(t);
  expect(await ticketRow(t.ticketId)).toMatchObject({ status: 'closed' });
  expect((await ticketRow(t.ticketId)).closed_on).not.toBeNull();
  await pools.root.query(`update hdt_tickets set status = 'closed', merged_into_id = $2 where ticket_id = $1`, [f.tickets.aMine.ticketId, t.ticketId]);
  const reopen = await rule({ name: 'Открыть', event: 'rated', actions: [{ action: 'set_status', status: 'in_progress' }] });
  await fire(f.tickets.aMine, f.orgA.orgId, 'rated');
  expect(await ticketRow(f.tickets.aMine.ticketId)).toMatchObject({ status: 'closed' });
  expect((await runs(reopen))[0]).toMatchObject({ result: 'failed', actions_done: [{ action: 'set_status', ok: false, detail: 'merged' }] });
  // Срабатывание без единого выполненного действия записи в историю и журнал аудита не оставляет.
  expect(await history(f.tickets.aMine.ticketId, 'rule')).toEqual([]);
});

test('права: правило меняет только обращение своего события, чужая организация не затронута', async () => {
  const ruleId = await rule({ conditions: [{ field: 'org', op: 'is', values: [f.orgA.orgId] }], actions: [{ action: 'set_priority', priority: 'p1' }, { action: 'add_note', text: 'Только для ACME' }] });
  const before = (await pools.root.query(`select ticket_id, modified_on, priority from hdt_tickets order by ticket_id`)).rows;
  // Событие обращения организации Б: условие "организация А" не выполнено, правило не срабатывает.
  await fire(f.tickets.bOrg, f.orgB.orgId);
  expect(await runs()).toEqual([]);
  expect((await pools.root.query(`select ticket_id, modified_on, priority from hdt_tickets order by ticket_id`)).rows).toEqual(before);
  // Событие обращения организации А: меняется только оно.
  await fire(f.tickets.aOrg);
  const after = (await pools.root.query(`select ticket_id, modified_on, priority from hdt_tickets order by ticket_id`)).rows;
  expect(after.filter((row, index) => row.modified_on.getTime() !== before[index].modified_on.getTime()).map((row) => row.ticket_id)).toEqual([f.tickets.aOrg.ticketId]);
  expect((await runs(ruleId)).map((r) => [r.ticket_id, r.org_id])).toEqual([[f.tickets.aOrg.ticketId, f.orgA.orgId]]);
  expect((await pools.root.query(`select distinct ticket_id from hdt_ticket_messages where is_auto`)).rows).toEqual([{ ticket_id: f.tickets.aOrg.ticketId }]);
  // Событие с чужой организацией записать нельзя: внешний ключ держит пару обращение и организация.
  await expect(emit(f.tickets.bOrg, f.orgA.orgId)).rejects.toThrow(/hdc_domain_events_f1/);
});

test('порядок правил: следующее правило видит изменения предыдущего; "остановить" прекращает разбор', async () => {
  const t = f.tickets.aOrg;
  const tagId = await tag('Эскалация');
  const first = await rule({ name: 'Поднять приоритет', actions: [{ action: 'set_priority', priority: 'p1' }] });
  const second = await rule({ name: 'Тег для P1', conditions: [{ field: 'priority', op: 'is', values: ['p1'] }], actions: [{ action: 'add_tag', tagId }] });
  const third = await rule({ name: 'Заметка', actions: [{ action: 'add_note', text: 'Третье правило' }] });
  await fire(t);
  // Второе правило сработало, потому что первое уже подняло приоритет.
  expect((await runs()).map((r) => r.rule_id)).toEqual([first, second, third]);
  expect((await history(t.ticketId, 'rule')).map((e) => e.payload.ruleName)).toEqual(['Поднять приоритет', 'Тег для P1', 'Заметка']);

  // Второе правило раньше первого: на момент проверки приоритет ещё P2, условие не выполнено.
  await pools.root.query(`delete from hdw_rule_runs`);
  await pools.root.query(`update hdt_tickets set priority = 'p2' where ticket_id = $1`, [f.tickets.aMine.ticketId]);
  await moveRule(admin, { ruleId: second, direction: 'up' });
  await fire(f.tickets.aMine);
  expect((await runs()).map((r) => r.rule_id)).toEqual([first, third]);

  // "Остановить обработку следующих" у первого правила: остальные не применяются.
  await pools.root.query(`delete from hdw_rule_runs`);
  await saveRule(admin, { ruleId: first, name: 'Поднять приоритет', event: 'client_replied', conditions: { match: 'all', items: [] }, actions: [{ action: 'set_priority', priority: 'p1' }], isStop: true });
  await moveRule(admin, { ruleId: first, direction: 'up' });
  await fire(f.tickets.aPrivate);
  expect((await runs()).map((r) => r.rule_id)).toEqual([first]);
  // Флаг действует только когда правило сработало: если условия не выполнены, следующие правила идут.
  await pools.root.query(`delete from hdw_rule_runs`);
  await saveRule(admin, { ruleId: first, name: 'Поднять приоритет', event: 'client_replied', conditions: { match: 'all', items: [{ field: 'type', op: 'is', values: ['question'] }] }, actions: [{ action: 'set_priority', priority: 'p1' }], isStop: true });
  await fire(f.tickets.bOrg, f.orgB.orgId);
  expect((await runs()).map((r) => r.rule_id)).toEqual([third]);
});

test('выключенное правило и правило другого события не срабатывают; событие, порождённое правилом, не разбирается', async () => {
  const t = f.tickets.aOrg;
  const off = await rule({ actions: [{ action: 'add_note', text: 'Выключено' }] });
  await setRuleEnabled(admin, { ruleId: off, enabled: false });
  await rule({ event: 'rated', actions: [{ action: 'add_note', text: 'Другое событие' }] });
  const on = await rule({ actions: [{ action: 'add_note', text: 'Включено' }] });
  await emit(t, f.orgA.orgId, 'client_replied', true);
  expect(await drain()).toMatchObject({ processed: 1, failed: 0 });
  expect(await runs()).toEqual([]);
  await fire(t);
  expect((await runs()).map((r) => r.rule_id)).toEqual([on]);
});

test('зацикливание: два правила, меняющие приоритет друг за другом, не порождают цепочку', async () => {
  const t = f.tickets.aOrg;
  const down = await rule({ name: 'P1 в P2', event: 'priority_changed', conditions: [{ field: 'priority', op: 'is', values: ['p1'] }], actions: [{ action: 'set_priority', priority: 'p2' }] });
  const up = await rule({ name: 'P2 в P1', event: 'priority_changed', conditions: [{ field: 'priority', op: 'is', values: ['p2'] }], actions: [{ action: 'set_priority', priority: 'p1' }] });
  // Сотрудник поднимает приоритет: настоящее событие, на него срабатывают оба правила по одному разу.
  await setPriority(staffCtx(f.l1), { number: t.number, priority: 'p1', reason: 'Клиент не может отгружать', seenVersion: new Date(Date.now() + 5000).toISOString() });
  const first = await drain();
  expect(first.failed).toBe(0);
  expect((await runs()).map((r) => r.rule_id)).toEqual([down, up]);
  // Действия правил записали свои события с отметкой "порождено правилом": они разобраны и правил не запустили.
  const events = (await pools.root.query(`select kind, is_by_rule, processed_on from hdc_domain_events where ticket_id = $1 order by event_id`, [t.ticketId])).rows;
  expect(events.map((e) => [e.kind, e.is_by_rule, e.processed_on !== null])).toEqual([
    ['priority_changed', false, true],
    ['priority_changed', true, true],
    ['priority_changed', true, true],
  ]);
  expect(await drain()).toMatchObject({ processed: 0 });
  expect(await runs()).toHaveLength(2);
  expect(await ticketRow(t.ticketId)).toMatchObject({ priority: 'p1' });
});

test('зацикливание: одиннадцатое срабатывание правила на обращении за час достигнуто на обращениях трёх организаций: правило выключается, администраторы уведомлены', async () => {
  const t = f.tickets.aOrg;
  const second = await staffWithRole('admin');
  const ruleId = await rule({ name: 'Заметка на каждый ответ', actions: [{ action: 'add_note', text: 'Клиент ответил' }] });
  const other = await rule({ name: 'Соседнее правило', conditions: [{ field: 'priority', op: 'is', values: ['p2'] }], actions: [{ action: 'set_priority', priority: 'p3' }] });
  // Предел на одном обращении правило только приостанавливает (проверка вехи M8, находка S1; подробно в
  // m8-review-engine.test.ts). Выключается оно, когда предел за час достигнут на обращениях трёх организаций:
  // сначала его достигают обращение организации Б и обращение третьей организации.
  const orgC = (await pools.root.query(`insert into hdu_organizations (server_id, external_company_id, name) values ($1, '503', 'Initech') returning org_id`, [f.server.serverId])).rows[0].org_id as string;
  const cTicket = (
    await pools.root.query(
      `insert into hdt_tickets (org_id, author_id, type, impact, priority, visibility, title, description, locale, source)
       values ($1, $2, 'bug', 'major', 'p2', 'org', 'Третья организация', 'Третья организация: описание', 'ru', 'portal') returning ticket_id`,
      [orgC, f.aUser.userId],
    )
  ).rows[0].ticket_id as string;
  for (const [ticket, orgId] of [[f.tickets.bOrg, f.orgB.orgId], [{ ticketId: cTicket } as TicketRef, orgC]] as const) {
    for (let i = 0; i < 11; i++) await emit(ticket, orgId);
    expect((await drain()).run.loops).toBe(0);
  }
  expect((await pools.root.query(`select is_enabled, disabled_reason from hdw_rules where rule_id = $1`, [ruleId])).rows).toEqual([{ is_enabled: true, disabled_reason: null }]);
  for (let i = 0; i < 11; i++) await emit(t, f.orgA.orgId);
  const result = await drain();
  // Одиннадцать событий клиента и одно событие смены приоритета от соседнего правила (оно разобрано без правил).
  expect(result).toMatchObject({ processed: 12, failed: 0 });
  expect(result.run.loops).toBe(1);
  const mine = (await runs(ruleId)).filter((r) => r.ticket_id === t.ticketId);
  expect(mine.map((r) => r.result)).toEqual([...Array.from({ length: 10 }, () => 'applied'), 'skipped_loop']);
  expect(mine.at(-1)?.actions_done).toEqual([]);
  expect((await messagesOf(t.ticketId)).filter((m) => m.is_auto)).toHaveLength(10);
  expect((await pools.root.query(`select is_enabled, disabled_reason from hdw_rules where rule_id = $1`, [ruleId])).rows).toEqual([{ is_enabled: false, disabled_reason: 'loop' }]);
  // Соседнее правило того же события продолжает работать.
  expect((await pools.root.query(`select is_enabled from hdw_rules where rule_id = $1`, [other])).rows).toEqual([{ is_enabled: true }]);
  expect((await runs(other)).filter((r) => r.ticket_id === t.ticketId)).toHaveLength(1);
  const audit = await auditOf(ruleId);
  expect(audit.at(-1)).toMatchObject({ action: 'rule.disabled_loop', actor_type: 'system', diff: { name: 'Заметка на каждый ответ', ticketId: t.ticketId, number: t.number } });
  // Уведомление в портале каждому действующему администратору, без привязки к обращению.
  const notices = (await pools.root.query(`select user_id, ticket_id, payload from hdn_notifications where kind = 'rule_disabled'`)).rows;
  expect(new Set(notices.map((n) => n.user_id))).toEqual(new Set([f.adminStaff.userId, second.userId]));
  for (const n of notices) expect(n).toMatchObject({ ticket_id: null, payload: { rule: 'Заметка на каждый ответ' } });

  // Выключенное правило больше не срабатывает; администратор включает его снова, причина снимается.
  const before = (await runs(ruleId)).length;
  await fire(t);
  expect(await runs(ruleId)).toHaveLength(before);
  await setRuleEnabled(admin, { ruleId, enabled: true });
  expect((await pools.root.query(`select is_enabled, disabled_reason from hdw_rules where rule_id = $1`, [ruleId])).rows).toEqual([{ is_enabled: true, disabled_reason: null }]);
  // На другом обращении счётчик свой: правило срабатывает.
  await fire(f.tickets.aMine);
  expect((await runs(ruleId)).at(-1)).toMatchObject({ ticket_id: f.tickets.aMine.ticketId, result: 'applied' });
});

test('ссылка на удалённое: действие с удалённым тегом, выключенным шаблоном или уволенным сотрудником не выполняется, срабатывание не падает', async () => {
  const t = f.tickets.aOrg;
  const tagId = await tag('Временный');
  const templateId = await template({ ru: 'Текст шаблона' });
  const gone = await staffWithRole('agent_l1');
  await endpoint();
  const ruleId = await rule({
    actions: [
      { action: 'add_tag', tagId },
      { action: 'reply_template', templateId },
      { action: 'assign', userId: gone.userId },
      { action: 'notify', target: { kind: 'user', userId: gone.userId } },
      { action: 'webhook', endpointId: '019a1111-1111-7111-8111-111111111111' },
      { action: 'set_priority', priority: 'p4' },
    ],
  });
  await pools.root.query(`delete from hdr_tags where tag_id = $1`, [tagId]);
  await pools.root.query(`delete from hdw_webhook_endpoints where endpoint_id = $1`, [ENDPOINT]);
  await pools.root.query(`update hdr_reply_templates set is_enabled = false where template_id = $1`, [templateId]);
  await pools.root.query(`update hdu_staff set state = 'passive' where user_id = $1`, [gone.userId]);
  await emit(t, f.orgA.orgId);
  // Событие клиента и событие смены приоритета от самого правила: второе разобрано без правил.
  expect(await drain()).toMatchObject({ processed: 2, failed: 0 });
  const [run] = await runs(ruleId);
  expect(run?.result).toBe('partial');
  expect(run?.actions_done).toEqual([
    { action: 'add_tag', ok: false, detail: 'tag_missing' },
    { action: 'reply_template', ok: false, detail: 'template_disabled' },
    { action: 'assign', ok: false, detail: 'user_missing' },
    { action: 'notify', ok: false, detail: 'user_missing' },
    // Адреса с таким идентификатором в списке администратора нет: доставка не ставится.
    { action: 'webhook', ok: false, detail: 'endpoint_missing' },
    { action: 'set_priority', ok: true, from: 'p2', to: 'p4' },
  ]);
  expect(await ticketRow(t.ticketId)).toMatchObject({ priority: 'p4', assignee_id: null });
  expect((await messagesOf(t.ticketId)).filter((m) => m.is_auto)).toEqual([]);

  // Постановка доставки получает идентификаторы обращения, организации и правила, вид и идентификатор события.
  const calls: unknown[] = [];
  setWebhookDeliverer(async (_tx, input) => {
    calls.push(input);
    return { ok: true };
  });
  await endpoint();
  const hook = await rule({ name: 'Вебхук', event: 'rated', actions: [{ action: 'webhook', endpointId: '019a1111-1111-7111-8111-111111111111' }] });
  const ratedId = await fire(t, f.orgA.orgId, 'rated');
  expect(calls).toEqual([{ endpointId: '019a1111-1111-7111-8111-111111111111', ticketId: t.ticketId, orgId: f.orgA.orgId, ruleId: hook, event: 'rated', eventId: ratedId, now: expect.any(Date) }]);
  expect((await runs(hook))[0]).toMatchObject({ result: 'applied', actions_done: [{ action: 'webhook', ok: true }] });
});

test('сбой внутри действия откатывает только это действие: остальные действия и отметка разбора события сохраняются', async () => {
  const t = f.tickets.aOrg;
  await endpoint();
  setWebhookDeliverer(async (tx) => {
    // Запись в середине действия, затем сбой: точка сохранения откатывает и запись.
    await tx.execute(`insert into hdt_ticket_messages (org_id, ticket_id, author_type, body, is_internal, is_auto) values ('${f.orgA.orgId}', '${t.ticketId}', 'system', 'Наполовину', true, true)`);
    // Сбой, который повтор не исправит: нарушение ограничения базы (пустой текст сообщения). Временный сбой
    // событие повторяет целиком: это проверяет m8-review-engine.test.ts.
    await tx.execute(`insert into hdt_ticket_messages (org_id, ticket_id, author_type, body, is_internal, is_auto) values ('${f.orgA.orgId}', '${t.ticketId}', 'system', '', true, true)`);
    return { ok: true };
  });
  const ruleId = await rule({ actions: [{ action: 'set_priority', priority: 'p1' }, { action: 'webhook', endpointId: '019a1111-1111-7111-8111-111111111111' }, { action: 'add_note', text: 'После сбоя' }] });
  await emit(t, f.orgA.orgId);
  expect(await drain()).toMatchObject({ processed: 2, failed: 0 });
  expect((await runs(ruleId))[0]).toMatchObject({
    result: 'partial',
    actions_done: [
      { action: 'set_priority', ok: true, from: 'p2', to: 'p1' },
      { action: 'webhook', ok: false, detail: 'error' },
      { action: 'add_note', ok: true },
    ],
  });
  expect((await messagesOf(t.ticketId)).filter((m) => m.is_auto).map((m) => m.body)).toEqual(['После сбоя']);
  expect(await ticketRow(t.ticketId)).toMatchObject({ priority: 'p1' });
});

test('распределение по кругу: сотрудник линии обращения с наименьшим числом открытых обращений, при равенстве кому назначали раньше', async () => {
  const second = await staffWithRole('agent_l1');
  const third = await staffWithRole('agent_l1');
  const l2 = await staffWithRole('agent_l2');
  const product = await staffWithRole('product');
  const passive = await staffWithRole('agent_l1');
  await pools.root.query(`update hdu_staff set state = 'passive' where user_id = $1`, [passive.userId]);
  const ruleId = await rule({ actions: [{ action: 'assign_round_robin' }] });
  // У Азиза (первая линия из набора) два открытых обращения, у второго одно, у третьего одно решённое (не в счёт).
  await pools.root.query(`update hdt_tickets set assignee_id = $1 where ticket_id = any($2)`, [f.l1.userId, [f.tickets.bOrg.ticketId, f.tickets.bPrivate.ticketId]]);
  await pools.root.query(`update hdt_tickets set assignee_id = $1 where ticket_id = $2`, [second.userId, f.tickets.aPrivate.ticketId]);
  await pools.root.query(`update hdt_tickets set assignee_id = $1, status = 'resolved' where ticket_id = $2`, [third.userId, f.tickets.aMine.ticketId]);
  await fire(f.tickets.aOrg);
  // Меньше всего открытых у третьего: ноль.
  expect(await ticketRow(f.tickets.aOrg.ticketId)).toMatchObject({ assignee_id: third.userId });
  expect((await runs(ruleId))[0]?.actions_done).toEqual([{ action: 'assign_round_robin', ok: true, from: null, to: third.name }]);
  expect((await history(f.tickets.aOrg.ticketId, 'assignee')).at(-1)).toMatchObject({ actor_type: 'system', payload: { to: third.userId, byRule: true } });

  // Теперь у второго и третьего по одному открытому: при равенстве берётся тот, кому назначали раньше всех.
  // Второму не назначали никогда (строка поставлена напрямую), третьему только что: следующий второй.
  const fresh = await createTicket(await clientCtx(f.aUser), { description: 'Новое обращение для распределения', type: 'bug', impact: 'minor', visibility: 'org', locale: 'ru' });
  const freshRow = (await pools.root.query(`select ticket_id from hdt_tickets where number = $1`, [fresh.number])).rows[0];
  await pools.root.query(`update hdc_domain_events set processed_on = now() where processed_on is null`);
  await fire({ ticketId: freshRow.ticket_id, number: fresh.number, title: '' });
  expect(await ticketRow(freshRow.ticket_id)).toMatchObject({ assignee_id: second.userId });

  // Исполнитель уже из линии обращения: повторное срабатывание его не меняет.
  await fire(f.tickets.aOrg);
  expect(await ticketRow(f.tickets.aOrg.ticketId)).toMatchObject({ assignee_id: third.userId });
  expect((await runs(ruleId)).at(-1)?.actions_done).toEqual([{ action: 'assign_round_robin', ok: true, from: third.name, to: third.name, unchanged: true }]);

  // Обращение второй линии получает сотрудника второй линии; роль product, выключенный сотрудник и первая линия не берутся.
  await pools.root.query(`update hdt_tickets set queue = 'l2', assignee_id = null where ticket_id = $1`, [f.tickets.bOrg.ticketId]);
  await fire(f.tickets.bOrg, f.orgB.orgId);
  expect(await ticketRow(f.tickets.bOrg.ticketId)).toMatchObject({ assignee_id: l2.userId });
  // В очереди Customer Care один сотрудник набора.
  await pools.root.query(`update hdt_tickets set queue = 'care', assignee_id = null where ticket_id = $1`, [f.tickets.bPrivate.ticketId]);
  await fire(f.tickets.bPrivate, f.orgB.orgId);
  expect(await ticketRow(f.tickets.bPrivate.ticketId)).toMatchObject({ assignee_id: f.care.userId });
  const assigned = (await pools.root.query(`select distinct assignee_id from hdt_tickets where assignee_id is not null`)).rows.map((row) => row.assignee_id);
  expect(assigned).not.toContain(product.userId);
  expect(assigned).not.toContain(passive.userId);

  // В линии нет действующих сотрудников: действие не выполнено.
  await pools.root.query(`update hdu_staff set state = 'passive' where role = 'care'`);
  await pools.root.query(`update hdt_tickets set assignee_id = null where ticket_id = $1`, [f.tickets.bPrivate.ticketId]);
  await fire(f.tickets.bPrivate, f.orgB.orgId);
  expect((await runs(ruleId)).at(-1)).toMatchObject({ result: 'failed', actions_done: [{ action: 'assign_round_robin', ok: false, detail: 'no_candidates' }] });
});

test('от создания обращения клиентом до записи в истории: событие, разбор, правило', async () => {
  const tagId = await tag('Блокер');
  const ruleId = await rule({
    name: 'Блокер от клиента',
    event: 'ticket_created',
    conditions: [
      { field: 'priority', op: 'is', values: ['p1'] },
      { field: 'text', op: 'contains_any', words: ['отгрузк'] },
      { field: 'org_category', op: 'is', values: ['A'] },
      { field: 'source', op: 'is', values: ['portal'] },
    ],
    actions: [{ action: 'add_tag', tagId }, { action: 'set_queue', queue: 'care' }],
  });
  await pools.root.query(`update hdu_organizations set category = 'A' where org_id = $1`, [f.orgA.orgId]);
  const client = await clientCtx(f.aUser);
  const hit = await createTicket(client, { description: 'Остановилась ОТГРУЗКА со склада', type: 'bug', impact: 'blocker', visibility: 'org', locale: 'ru' });
  const miss = await createTicket(client, { description: 'Вопрос по отчёту о продажах', type: 'question', impact: 'blocker', visibility: 'org', locale: 'ru' });
  const other = await createTicket(await clientCtx(f.bUser), { description: 'Остановилась отгрузка со склада', type: 'bug', impact: 'blocker', visibility: 'org', locale: 'ru' });
  expect(await drain()).toMatchObject({ processed: 3, failed: 0 });
  const applied = await runs(ruleId);
  const hitRow = (await pools.root.query(`select ticket_id, queue from hdt_tickets where number = $1`, [hit.number])).rows[0];
  expect(applied.map((r) => r.ticket_id)).toEqual([hitRow.ticket_id]);
  expect(hitRow.queue).toBe('care');
  for (const number of [miss.number, other.number]) expect((await pools.root.query(`select queue from hdt_tickets where number = $1`, [number])).rows[0].queue).toBe('l1');
  const view = await getAgentTicket(staffCtx(f.care), hit.number);
  expect(view?.tags.map((item) => item.name)).toEqual(['Блокер']);
  expect(view?.timeline.filter((e) => e.type === 'event').map((e) => (e.type === 'event' ? [e.kind, e.payload.ruleName] : []))).toEqual([['rule', 'Блокер от клиента']]);
});

// --- Событие "нет активности" ---

const silent = (now: Date, opts: { batch?: number; perRun?: number } = {}) => runNoActivityRules(SYSTEM, { now, ...opts });
const later = (hours: number) => new Date(Date.now() + hours * HOUR);
const onlyAOrg = { field: 'text', op: 'contains_any', words: ['Отчёт А'] };

test('нет активности: правило срабатывает один раз на молчание и снова после нового сообщения человека', async () => {
  const t = f.tickets.aOrg;
  const ruleId = await rule({ name: 'Молчание 2 часа', event: 'no_activity', hours: 2, conditions: [onlyAOrg], actions: [{ action: 'add_note', text: 'Два часа без сообщений' }] });
  // Последнее сообщение человека: публичное сообщение клиента из набора. Заметка сотрудника не в счёт.
  const last = (await pools.root.query(`select message_id from hdt_ticket_messages where ticket_id = $1 and not is_internal order by created_on desc limit 1`, [t.ticketId])).rows[0].message_id as string;
  // Прошёл час: рано.
  expect(await silent(later(1))).toMatchObject({ applied: 0 });
  expect(await runs(ruleId)).toEqual([]);
  // Прошло три часа: срабатывает, отметка молчания это последнее сообщение.
  expect(await silent(later(3))).toMatchObject({ applied: 1, failed: 0 });
  const [first] = await runs(ruleId);
  expect(first).toMatchObject({ ticket_id: t.ticketId, org_id: f.orgA.orgId, event_id: null, result: 'applied', marker: last });
  expect((await history(t.ticketId, 'rule')).map((e) => e.payload.ruleName)).toEqual(['Молчание 2 часа']);
  expect((await auditOf(t.ticketId)).map((a) => a.action)).toEqual(['rule.applied']);
  // Повторные запуски в то же молчание ничего не делают: заметка самого правила молчание не прерывает.
  expect(await silent(later(3))).toMatchObject({ applied: 0 });
  expect(await silent(later(30))).toMatchObject({ applied: 0 });
  // Внутренняя заметка сотрудника тоже не прерывает молчание.
  await postStaffMessage(staffCtx(f.l1), { number: t.number, body: 'Заметка для коллег', internal: true, attachmentIds: [], waitForClient: false, seenVersion: new Date(Date.now() + 5000).toISOString() });
  expect(await silent(later(30))).toMatchObject({ applied: 0 });
  expect(await runs(ruleId)).toHaveLength(1);

  // Клиент написал: правило взведено заново и срабатывает через два часа после нового сообщения.
  await replyToTicket(await clientCtx(f.aUser), { number: t.number, body: 'Есть новости?' });
  expect(await silent(later(1))).toMatchObject({ applied: 0 });
  expect(await silent(later(3))).toMatchObject({ applied: 1 });
  const all = await runs(ruleId);
  expect(all).toHaveLength(2);
  expect(all[1]?.marker).not.toBe(last);
  expect((await messagesOf(t.ticketId)).filter((m) => m.is_auto)).toHaveLength(2);
});

test('нет активности: два запуска одновременно дают одно срабатывание', async () => {
  const ruleId = await rule({ event: 'no_activity', hours: 1, actions: [{ action: 'add_note', text: 'Молчание' }] });
  const now = later(2);
  const results = await Promise.all([silent(now), silent(now), silent(now)]);
  // Пять обращений набора, все открыты и молчат: по одному срабатыванию на каждое, сколько бы запусков ни шло.
  expect(results.reduce((sum, r) => sum + r.applied, 0)).toBe(5);
  const all = await runs(ruleId);
  expect(all).toHaveLength(5);
  expect(new Set(all.map((r) => r.ticket_id)).size).toBe(5);
  expect((await pools.root.query(`select count(*)::int as n from hdt_ticket_messages where is_auto`)).rows[0].n).toBe(5);
  // Уникальная отметка держит границу и без блокировки строки: вторую строку с той же отметкой база не принимает.
  const one = all[0] as RunRow;
  await expect(
    asActor(pools.app, SYSTEM, (c) => c.query(`insert into hdw_rule_runs (org_id, rule_id, ticket_id, result, marker) values ($1, $2, $3, 'applied', $4)`, [one.org_id, ruleId, one.ticket_id, one.marker])),
  ).rejects.toThrow(/hdw_rule_runs_u1/);
});

test('нет активности: решённые и закрытые не берутся, пока условие правила не назовёт статус; обращение без сообщений считается от создания', async () => {
  await pools.root.query(`update hdt_tickets set status = 'closed' where ticket_id = $1`, [f.tickets.aOrg.ticketId]);
  await pools.root.query(`update hdt_tickets set status = 'resolved' where ticket_id = $1`, [f.tickets.aMine.ticketId]);
  await pools.root.query(`delete from hdt_ticket_messages where ticket_id = $1`, [f.tickets.bOrg.ticketId]);
  const open = await rule({ name: 'Открытые', event: 'no_activity', hours: 1, actions: [{ action: 'add_note', text: 'Молчание' }] });
  const closed = await rule({ name: 'Закрытые', event: 'no_activity', hours: 1, conditions: [{ field: 'status', op: 'is', values: ['closed'] }], actions: [{ action: 'add_note', text: 'Закрыто и молчит' }] });
  // Пачками по два обращения: правило проходит весь список за один запуск.
  await silent(later(2), { batch: 2 });
  expect(new Set((await runs(open)).map((r) => r.ticket_id))).toEqual(new Set([f.tickets.aPrivate.ticketId, f.tickets.bOrg.ticketId, f.tickets.bPrivate.ticketId]));
  expect((await runs(open)).find((r) => r.ticket_id === f.tickets.bOrg.ticketId)?.marker).toBe('created');
  expect((await runs(closed)).map((r) => r.ticket_id)).toEqual([f.tickets.aOrg.ticketId]);
});

test('нет активности: просмотр ограничен за запуск и продолжается со следующего места', async () => {
  const ruleId = await rule({ event: 'no_activity', hours: 1, actions: [{ action: 'add_note', text: 'Молчание' }] });
  const now = later(2);
  // За запуск правило просматривает не больше двух обращений из пяти: следующий запуск берёт следующие.
  expect(await silent(now, { batch: 2, perRun: 2 })).toMatchObject({ checked: 2, applied: 2 });
  expect(await silent(now, { batch: 2, perRun: 2 })).toMatchObject({ checked: 2, applied: 2 });
  expect(await silent(now, { batch: 2, perRun: 2 })).toMatchObject({ checked: 1, applied: 1 });
  expect(await runs(ruleId)).toHaveLength(5);
  // Круг пройден: следующий запуск начинает сначала и ничего не повторяет.
  expect(await silent(now, { batch: 2, perRun: 2 })).toMatchObject({ checked: 2, applied: 0 });
});

/** Сдвигает обращение и его сообщения в прошлое: служебные колонки защищены триггером, поэтому без триггеров. */
async function age(ticketId: string, hours: number): Promise<void> {
  const client = await pools.root.connect();
  try {
    await client.query('begin');
    await client.query('set local session_replication_role = replica');
    await client.query(`update hdt_tickets set created_on = created_on - make_interval(hours => $2) where ticket_id = $1`, [ticketId, hours]);
    await client.query(`update hdt_ticket_messages set created_on = created_on - make_interval(hours => $2) where ticket_id = $1`, [ticketId, hours]);
    await client.query('commit');
  } finally {
    client.release();
  }
}
const enabledOn = (ruleId: string) => pools.root.query(`select enabled_on from hdw_rules where rule_id = $1`, [ruleId]).then((r) => r.rows[0].enabled_on as Date | null);

test('нет активности: обращения, молчавшие N часов до включения правила, не срабатывают; перешедшее порог после включения срабатывает один раз', async () => {
  const backlog = f.tickets.aOrg;
  const fresh = f.tickets.aMine;
  // Одно обращение молчит пять часов, второе час; остальные обращения набора не подходят по условию.
  await age(backlog.ticketId, 5);
  await age(fresh.ticketId, 1);
  const definition = { name: 'Молчание 2 часа', event: 'no_activity', hours: 2, conditions: { match: 'all', items: [{ field: 'text', op: 'contains_any', words: ['Отчёт А', 'Личное обращение пользователя А'] }] }, actions: [{ action: 'add_note', text: 'Два часа без сообщений' }], isStop: false };
  const { ruleId } = await saveRule(admin, definition);
  expect(await enabledOn(ruleId)).toBeNull();
  await setRuleEnabled(admin, { ruleId, enabled: true });
  const first = await enabledOn(ruleId);
  expect(first).toBeInstanceOf(Date);
  // Сразу после включения: накопившееся молчание не срабатывает, второе обращение ещё не дошло до порога.
  expect(await silent(new Date())).toMatchObject({ applied: 0 });
  expect(await runs(ruleId)).toEqual([]);
  // Через полтора часа второе обращение молчит 2,5 часа: порог пройден после включения, срабатывание одно.
  expect(await silent(later(1.5))).toMatchObject({ applied: 1, failed: 0 });
  expect(await silent(later(30))).toMatchObject({ applied: 0 });
  expect((await runs(ruleId)).map((r) => r.ticket_id)).toEqual([fresh.ticketId]);
  expect(await history(backlog.ticketId, 'rule')).toEqual([]);
  // Пробный прогон от включения не зависит: условия подходят обоим обращениям.
  const dry = await dryRunRule(admin, definition);
  expect(dry.matches.map((m) => m.number)).toEqual(expect.arrayContaining([backlog.number, fresh.number]));
  // Новое сообщение в давно молчавшем обращении взводит правило: порог будет пройден после включения.
  await replyToTicket(await clientCtx(f.aUser), { number: backlog.number, body: 'Есть новости?' });
  expect(await silent(later(1))).toMatchObject({ applied: 0 });
  expect(await silent(later(3))).toMatchObject({ applied: 1 });
  expect((await runs(ruleId)).map((r) => r.ticket_id).sort()).toEqual([backlog.ticketId, fresh.ticketId].sort());
});

test('нет активности: выключение хранит момент включения, повторное включение ставит его заново', async () => {
  const t = f.tickets.aOrg;
  const ruleId = await rule({ event: 'no_activity', hours: 2, conditions: [onlyAOrg], actions: [{ action: 'add_note', text: 'Молчание' }] });
  const first = (await enabledOn(ruleId)) as Date;
  await setRuleEnabled(admin, { ruleId, enabled: false });
  expect(await enabledOn(ruleId)).toEqual(first);
  // Пока правило было выключено, обращение перешло порог: после повторного включения оно не срабатывает.
  await age(t.ticketId, 3);
  await setRuleEnabled(admin, { ruleId, enabled: true });
  const second = (await enabledOn(ruleId)) as Date;
  expect(second.getTime()).toBeGreaterThan(first.getTime());
  expect(await silent(later(30))).toMatchObject({ applied: 0 });
  // Правило без момента включения (поставленное миграцией) границы не имеет.
  await pools.root.query(`update hdw_rules set enabled_on = null where rule_id = $1`, [ruleId]);
  expect(await silent(new Date())).toMatchObject({ applied: 1 });
});

test('ночная очистка удаляет срабатывания старше 90 суток; удаление правила убирает его журнал', async () => {
  const ruleId = await rule({ actions: [{ action: 'add_note', text: 'Заметка' }] });
  await fire(f.tickets.aOrg);
  await fire(f.tickets.aMine);
  await pools.root.query(`update hdw_rule_runs set created_on = now() - interval '91 days' where ticket_id = $1`, [f.tickets.aOrg.ticketId]);
  expect(await cleanupRuleRuns({ type: 'system', job: 'maintenance.cleanup' })).toBe(1);
  expect((await runs(ruleId)).map((r) => r.ticket_id)).toEqual([f.tickets.aMine.ticketId]);
  await deleteRule(admin, { ruleId });
  expect(await runs()).toEqual([]);
  // История обращения и журнал аудита остаются.
  expect(await history(f.tickets.aMine.ticketId, 'rule')).toHaveLength(1);
  expect((await auditOf(ruleId)).map((a) => a.action)).toEqual(['rule.created', 'rule.enabled', 'rule.deleted']);
});
