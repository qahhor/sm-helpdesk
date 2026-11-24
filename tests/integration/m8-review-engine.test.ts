import { beforeEach, expect, test, vi } from 'vitest';
import { processEvents } from '@/modules/hdc/api';
import { createTicket, rateTicket } from '@/modules/hdt/api';
import { handleRuleEvent, newRuleRun, setWebhookDeliverer } from '@/modules/hdw/api/engine';
import { saveRule, setRuleEnabled } from '@/modules/hdw/api/rules';
import { clientCtx, staffCtx } from './helpers/auth';
import { seedBuiltinRules } from './helpers/automation';
import { pools } from './helpers/db';
import { type Fixture, seedTwoOrgs, type TicketRef } from './isolation/fixture';

// Исправления по независимой проверке вехи M8: применение правил и разбор событий (находки C1, S1, I7, m4).

// Сбои чтения идентичности (другое подключение, роль hub_auth): название организации, руководители линии, сотрудники.
const fail = vi.hoisted(() => ({ orgName: 0, leads: 0, roster: 0 }));
vi.mock('@/modules/hdu/api/recipients', async (original) => {
  const actual = await original<typeof import('@/modules/hdu/api/recipients')>();
  return {
    ...actual,
    organizationName: vi.fn(async (orgId: string) => {
      if (fail.orgName-- > 0) throw new Error('подключение идентичности оборвалось');
      return actual.organizationName(orgId);
    }),
    lineLeads: vi.fn(async (line: 'l1' | 'l2') => {
      if (fail.leads-- > 0) throw new Error('подключение идентичности оборвалось');
      return actual.lineLeads(line);
    }),
  };
});
vi.mock('@/modules/hdu/api/automation', async (original) => {
  const actual = await original<typeof import('@/modules/hdu/api/automation')>();
  return {
    ...actual,
    staffRoster: vi.fn(async () => {
      if (fail.roster-- > 0) throw new Error('подключение идентичности оборвалось');
      return actual.staffRoster();
    }),
  };
});

const SYSTEM = { type: 'system', job: 'automation.process' } as const;
const SECOND = 1000;
const MINUTE = 60 * SECOND;
let f: Fixture;
let admin: ReturnType<typeof staffCtx>;

beforeEach(async () => {
  f = await seedTwoOrgs();
  admin = staffCtx(f.adminStaff);
  await seedBuiltinRules();
  setWebhookDeliverer(null);
  fail.orgName = 0;
  fail.leads = 0;
  fail.roster = 0;
});

/** Разбор очереди в момент at (часы разбора подменены: от них считается пауза перед повтором). */
async function drainAt(at: number) {
  const run = newRuleRun();
  const result = await processEvents(SYSTEM, (tx, event) => handleRuleEvent(tx, event, run), { clock: () => at });
  return { ...result, run };
}
const outbox = (ticketId: string, template: string) =>
  pools.root.query(`select channel, recipient_kind from hdn_outbox where ticket_id = $1 and template = $2 order by channel`, [ticketId, template]).then((r) => r.rows);
const eventsOf = (ticketId: string) =>
  pools.root.query(`select kind, attempts, last_error, processed_on is not null as processed, next_attempt_on from hdc_domain_events where ticket_id = $1 order by event_id`, [ticketId]).then((r) => r.rows);
const runsOf = (ruleId: string) => pools.root.query(`select ticket_id, org_id, result, actions_done from hdw_rule_runs where rule_id = $1 order by run_id`, [ruleId]).then((r) => r.rows);
const ticketIdOf = async (number: number) => (await pools.root.query(`select ticket_id from hdt_tickets where number = $1`, [number])).rows[0].ticket_id as string;
const emit = (ticket: TicketRef | { ticketId: string }, orgId: string, kind = 'client_replied', byRule = false) =>
  pools.root
    .query(`insert into hdc_domain_events (org_id, ticket_id, kind, is_by_rule) values ($1, $2, $3, $4) returning event_id`, [orgId, ticket.ticketId, kind, byRule])
    .then((r) => r.rows[0].event_id as string);
type RuleInput = { name?: string; event?: string; conditions?: unknown[]; actions: unknown[]; isStop?: boolean };
async function rule(input: RuleInput): Promise<string> {
  const { ruleId } = await saveRule(admin, { name: input.name ?? 'Правило теста', event: input.event ?? 'client_replied', conditions: { match: 'all', items: input.conditions ?? [] }, actions: input.actions, isStop: input.isStop ?? false });
  await setRuleEnabled(admin, { ruleId, enabled: true });
  return ruleId;
}
async function p1(member: { userId: string }): Promise<{ number: number; ticketId: string }> {
  const { number } = await createTicket(await clientCtx(member), { description: 'Склад стоит', type: 'bug', impact: 'blocker', locale: 'ru' });
  return { number, ticketId: await ticketIdOf(number) };
}

// --- C1: сбой уведомления предустановленного правила не теряет уведомление ---

test('C1: разовый сбой в сообщении дежурным о P1 оставляет событие в очереди; следующий запуск отправляет сообщение ровно один раз', async () => {
  const t = await p1(f.aUser);
  const t0 = Date.now();
  fail.orgName = 1;
  expect(await drainAt(t0)).toMatchObject({ processed: 0, failed: 1 });
  // Событие не разобрано, сообщения и отметки нет, срабатывание не записано: транзакция события откатилась целиком.
  expect(await eventsOf(t.ticketId)).toMatchObject([{ kind: 'ticket_created', attempts: 1, processed: false }]);
  expect(await outbox(t.ticketId, 'oncall_p1')).toEqual([]);
  expect((await pools.root.query(`select oncall_notified_on from hdt_tickets where ticket_id = $1`, [t.ticketId])).rows[0].oncall_notified_on).toBeNull();
  expect((await pools.root.query(`select count(*)::int as n from hdw_rule_runs where ticket_id = $1`, [t.ticketId])).rows[0].n).toBe(0);
  // Следующий запуск после паузы: сообщение уходит, и ровно одно на каждый способ.
  expect(await drainAt(t0 + 11 * SECOND)).toMatchObject({ processed: 1, failed: 0 });
  expect(await outbox(t.ticketId, 'oncall_p1')).toEqual([{ channel: 'email', recipient_kind: 'oncall' }, { channel: 'telegram', recipient_kind: 'oncall' }]);
  expect(await drainAt(t0 + 30 * MINUTE)).toMatchObject({ processed: 0, failed: 0 });
  expect(await outbox(t.ticketId, 'oncall_p1')).toHaveLength(2);
});

test('C1: сбой чтения руководителей линии и сотрудников в уведомлениях о нарушении срока и о низкой оценке тоже повторяется', async () => {
  await pools.root.query(`update hdu_staff set is_lead = true where user_id = $1`, [f.l1.userId]);
  const breached = f.tickets.aOrg;
  await pools.root.query(`insert into hdc_domain_events (org_id, ticket_id, kind, payload) values ($1, $2, 'sla_breached', '{"deadline": "first_response"}')`, [f.orgA.orgId, breached.ticketId]);
  const rated = f.tickets.bOrg;
  await pools.root.query(`update hdt_tickets set status = 'closed', resolved_on = now(), closed_on = now(), sla_paused_on = now() where ticket_id = $1`, [rated.ticketId]);
  await rateTicket(await clientCtx(f.bUser), { number: rated.number, score: 1, reason: 'not_solved' });
  const t0 = Date.now();
  fail.leads = 1;
  fail.roster = 1;
  expect(await drainAt(t0)).toMatchObject({ processed: 0, failed: 2 });
  expect((await pools.root.query(`select count(*)::int as n from hdn_notifications where kind in ('sla_breach', 'csat_low')`)).rows[0].n).toBe(0);
  expect(await drainAt(t0 + 11 * SECOND)).toMatchObject({ processed: 2, failed: 0 });
  expect((await pools.root.query(`select kind, user_id from hdn_notifications where kind in ('sla_breach', 'csat_low') order by kind`)).rows).toEqual([
    { kind: 'csat_low', user_id: f.care.userId },
    { kind: 'sla_breach', user_id: f.l1.userId },
  ]);
});

test('C1: отказ чтения сотрудников не запоминается на весь запуск разбора', async () => {
  const run = newRuleRun();
  fail.roster = 1;
  await expect(run.roster()).rejects.toThrow();
  expect((await run.roster()).some((member) => member.userId === f.adminStaff.userId)).toBe(true);
});

test('C1: непредвиденный сбой обычного действия повторяет событие; на последней попытке записывается отказом, остальные действия выполняются', async () => {
  const t = f.tickets.aOrg;
  await pools.root.query(`insert into hdw_webhook_endpoints (endpoint_id, name, url) values ('019a1111-1111-7111-8111-111111111111', 'Учёт', 'https://hooks.partner.example/in')`);
  setWebhookDeliverer(async () => {
    throw new Error('сеть моргнула');
  });
  const ruleId = await rule({ actions: [{ action: 'webhook', endpointId: '019a1111-1111-7111-8111-111111111111' }, { action: 'add_note', text: 'После сбоя' }] });
  await emit(t, f.orgA.orgId);
  let at = Date.now();
  // Четыре попытки: событие каждый раз остаётся в очереди, срабатывание не записано.
  for (let attempt = 1; attempt <= 4; attempt++) {
    expect(await drainAt(at), `попытка ${attempt}`).toMatchObject({ processed: 0, failed: 1 });
    at += 16 * MINUTE;
  }
  expect(await runsOf(ruleId)).toEqual([]);
  // Пятая, последняя: сбой записан отказом действия, заметка поставлена, событие разобрано без потери.
  expect(await drainAt(at)).toMatchObject({ processed: 1, failed: 0 });
  expect(await runsOf(ruleId)).toMatchObject([{ result: 'partial', actions_done: [{ action: 'webhook', ok: false, detail: 'error' }, { action: 'add_note', ok: true }] }]);
  expect(await eventsOf(t.ticketId)).toMatchObject([{ attempts: 4, processed: true }]);
});

// --- C1: пауза перед повтором разбора события ---

test('C1: повтор разбора события идёт с паузой 10 секунд, 1, 5 и 15 минут; до срока событие не берётся, порядок по обращению сохраняется', async () => {
  const t = f.tickets.aOrg;
  const bad = await emit(t, f.orgA.orgId, 'status_changed');
  await emit(t, f.orgA.orgId, 'status_changed');
  const handler = async (_tx: unknown, event: { eventId: string }) => {
    if (event.eventId === bad) throw new Error('сбой');
  };
  const t0 = Date.now();
  let at = t0;
  const attempt = () => processEvents(SYSTEM, handler, { clock: () => at });
  const nextOn = async () => new Date((await eventsOf(t.ticketId))[0].next_attempt_on).getTime();
  expect(await attempt()).toEqual({ processed: 0, failed: 1 });
  expect(await nextOn()).toBe(t0 + 10 * SECOND);
  // Раньше срока событие не берётся, сколько бы раз задачу ни будили: попытки не тратятся.
  at = t0 + 9 * SECOND;
  for (let wake = 0; wake < 5; wake++) expect(await attempt()).toEqual({ processed: 0, failed: 0 });
  expect(await eventsOf(t.ticketId)).toMatchObject([{ attempts: 1, processed: false }, { attempts: 0, processed: false }]);
  const pauses = [MINUTE, 5 * MINUTE, 15 * MINUTE];
  for (const pause of pauses) {
    at = await nextOn();
    expect(await attempt()).toEqual({ processed: 0, failed: 1 });
    expect(await nextOn()).toBe(at + pause);
  }
  // Пятый сбой снимает событие; следующее событие обращения проходит.
  at = await nextOn();
  expect(await attempt()).toEqual({ processed: 1, failed: 1 });
  expect(await eventsOf(t.ticketId)).toMatchObject([{ attempts: 5, processed: true }, { attempts: 0, processed: true }]);
});

// --- S1: защита от зацикливания приостанавливает правило на обращении, а не выключает его для всех ---

/** Третья организация с обращением: набор изоляции заводит две. */
async function thirdOrg(): Promise<{ orgId: string; ticket: { ticketId: string; number: number } }> {
  const orgId = (await pools.root.query(`insert into hdu_organizations (server_id, external_company_id, name) values ($1, '503', 'Initech') returning org_id`, [f.server.serverId])).rows[0].org_id as string;
  const row = (
    await pools.root.query(
      `insert into hdt_tickets (org_id, author_id, type, impact, priority, visibility, title, description, locale, source)
       values ($1, $2, 'bug', 'major', 'p2', 'org', 'Третья организация', 'Третья организация: описание', 'ru', 'portal') returning ticket_id, number`,
      [orgId, f.aUser.userId],
    )
  ).rows[0];
  return { orgId, ticket: { ticketId: row.ticket_id as string, number: Number(row.number) } };
}
const ruleState = (ruleId: string) => pools.root.query(`select is_enabled, disabled_reason from hdw_rules where rule_id = $1`, [ruleId]).then((r) => r.rows[0]);
const noticesOf = (kind: string) => pools.root.query(`select user_id, ticket_id, payload from hdn_notifications where kind = $1 order by created_on, notification_id`, [kind]).then((r) => r.rows);
async function burst(ticket: { ticketId: string }, orgId: string, count: number) {
  for (let i = 0; i < count; i++) await emit(ticket, orgId);
  return drainAt(Date.now());
}

test('S1: одиннадцатый ответ клиента за час приостанавливает правило только на этом обращении; правило включено и работает на остальных', async () => {
  const t = f.tickets.aOrg;
  const ruleId = await rule({ name: 'Заметка на каждый ответ', actions: [{ action: 'add_note', text: 'Клиент ответил' }] });
  const first = await burst(t, f.orgA.orgId, 11);
  expect(first).toMatchObject({ processed: 11, failed: 0 });
  expect(first.run).toMatchObject({ loops: 0, paused: 1 });
  expect((await runsOf(ruleId)).map((run) => run.result)).toEqual([...Array.from({ length: 10 }, () => 'applied'), 'skipped_loop']);
  expect(await ruleState(ruleId)).toEqual({ is_enabled: true, disabled_reason: null });
  // Администратору уведомление "правило приостановлено на обращении", а не "правило выключено".
  expect(await noticesOf('rule_disabled')).toEqual([]);
  expect(await noticesOf('rule_paused')).toEqual([{ user_id: f.adminStaff.userId, ticket_id: t.ticketId, payload: { rule: 'Заметка на каждый ответ', number: t.number } }]);
  expect((await pools.root.query(`select action, diff from hdc_audit_log where object_id = $1 and action like 'rule.%loop'`, [ruleId])).rows).toMatchObject([
    { action: 'rule.paused_loop', diff: { name: 'Заметка на каждый ответ', ticketId: t.ticketId, number: t.number } },
  ]);
  // Ещё ответ в том же обращении: снова пропуск, второго уведомления нет.
  await burst(t, f.orgA.orgId, 1);
  expect((await runsOf(ruleId)).at(-1)).toMatchObject({ ticket_id: t.ticketId, result: 'skipped_loop', actions_done: [] });
  // Другое обращение той же организации тоже дошло до предела: правило по-прежнему включено, уведомление одно на правило в час.
  await burst(f.tickets.aMine, f.orgA.orgId, 11);
  expect(await ruleState(ruleId)).toEqual({ is_enabled: true, disabled_reason: null });
  expect(await noticesOf('rule_paused')).toHaveLength(1);
  // Обращение другой организации правило обрабатывает как обычно.
  await burst(f.tickets.bOrg, f.orgB.orgId, 1);
  expect((await runsOf(ruleId)).at(-1)).toMatchObject({ ticket_id: f.tickets.bOrg.ticketId, result: 'applied' });
  // Час прошёл: окно освободилось, правило снова срабатывает на первом обращении.
  await pools.root.query(`update hdw_rule_runs set created_on = created_on - interval '61 minutes' where rule_id = $1`, [ruleId]);
  await burst(t, f.orgA.orgId, 1);
  expect((await runsOf(ruleId)).at(-1)).toMatchObject({ ticket_id: t.ticketId, result: 'applied' });
});

test('S1: предел достигнут за час на обращениях трёх организаций: правило выключается для всех, запись в журнале и уведомление администраторам', async () => {
  const third = await thirdOrg();
  const ruleId = await rule({ name: 'Заметка на каждый ответ', actions: [{ action: 'add_note', text: 'Клиент ответил' }] });
  await burst(f.tickets.aOrg, f.orgA.orgId, 11);
  const second = await burst(f.tickets.bOrg, f.orgB.orgId, 11);
  // Две организации: правило ещё включено.
  expect(await ruleState(ruleId)).toEqual({ is_enabled: true, disabled_reason: null });
  expect(second.run).toMatchObject({ loops: 0, paused: 1 });
  const last = await burst(third.ticket, third.orgId, 11);
  expect(last.run).toMatchObject({ loops: 1 });
  expect(await ruleState(ruleId)).toEqual({ is_enabled: false, disabled_reason: 'loop' });
  expect((await pools.root.query(`select action, diff from hdc_audit_log where object_id = $1 and action = 'rule.disabled_loop'`, [ruleId])).rows).toMatchObject([
    { action: 'rule.disabled_loop', diff: { name: 'Заметка на каждый ответ', ticketId: third.ticket.ticketId, number: third.ticket.number, limit: 10 } },
  ]);
  expect(await noticesOf('rule_disabled')).toEqual([{ user_id: f.adminStaff.userId, ticket_id: null, payload: { rule: 'Заметка на каждый ответ' } }]);
  // Администратор включает правило снова: прежние пропуски не выключают его на первом же новом пределе.
  await setRuleEnabled(admin, { ruleId, enabled: true });
  await burst(f.tickets.aMine, f.orgA.orgId, 11);
  expect(await ruleState(ruleId)).toEqual({ is_enabled: true, disabled_reason: null });
});

// --- m4: "остановить" правила, у которого не выполнено ни одно действие ---

test('m4: правило, все действия которого отказали, не останавливает следующие правила', async () => {
  const t = f.tickets.aOrg;
  const tagId = (await pools.root.query(`insert into hdr_tags (name) values ('Удалят') returning tag_id`)).rows[0].tag_id as string;
  const broken = await rule({ name: 'Тег и стоп', actions: [{ action: 'add_tag', tagId }], isStop: true });
  const next = await rule({ name: 'Следующее', actions: [{ action: 'add_note', text: 'Дошло' }] });
  await pools.root.query(`delete from hdr_tags where tag_id = $1`, [tagId]);
  await burst(t, f.orgA.orgId, 1);
  expect(await runsOf(broken)).toMatchObject([{ result: 'failed', actions_done: [{ action: 'add_tag', ok: false, detail: 'tag_missing' }] }]);
  expect(await runsOf(next)).toMatchObject([{ result: 'applied' }]);
});

// --- I7: правило администратора с "остановить" не глушит уведомления портала ---

test('I7: правило с "остановить" выше предустановленных останавливает правила администратора, но не сообщение дежурным о P1', async () => {
  const { moveRule } = await import('@/modules/hdw/api/rules');
  const stopper = await rule({ name: 'Стоп для всех', event: 'ticket_created', actions: [{ action: 'add_note', text: 'Принято' }], isStop: true });
  const after = await rule({ name: 'После стопа', event: 'ticket_created', actions: [{ action: 'add_note', text: 'Не должно сработать' }] });
  // Правило администратора поднято на первое место: выше трёх предустановленных.
  for (let step = 0; step < 3; step++) await moveRule(admin, { ruleId: stopper, direction: 'up' });
  expect((await pools.root.query(`select rule_id from hdw_rules order by order_no limit 1`)).rows[0].rule_id).toBe(stopper);
  const t = await p1(f.aUser);
  expect(await drainAt(Date.now())).toMatchObject({ processed: 1, failed: 0 });
  expect(await runsOf(stopper)).toMatchObject([{ result: 'applied' }]);
  expect(await runsOf(after)).toEqual([]);
  expect(await outbox(t.ticketId, 'oncall_p1')).toHaveLength(2);
});

// --- I5: длинный просмотр молчащих обращений не задерживает события ---

test('I5: события, появившиеся во время просмотра молчащих обращений, разбираются в том же запуске задачи, а не ждут следующего', async () => {
  const { automationTick } = await import('@/worker/main');
  // Правило "нет активности" поднимает приоритет до P1: каждое срабатывание пишет событие смены приоритета, по
  // которому предустановленное правило должно сообщить дежурным.
  const { ruleId } = await saveRule(admin, { name: 'Молчит: поднять до P1', event: 'no_activity', hours: 1, conditions: { match: 'all', items: [] }, actions: [{ action: 'set_priority', priority: 'p1' }], isStop: false });
  await setRuleEnabled(admin, { ruleId, enabled: true });
  await pools.root.query(`delete from hdc_rate_limits`);
  const tickets = Object.values(f.tickets);
  await automationTick(SYSTEM, { silentCheckedAt: 0 }, { stopped: () => false, noActivity: { now: new Date(Date.now() + 2 * 60 * MINUTE), batch: 1 } });
  expect(await runsOf(ruleId)).toHaveLength(tickets.length);
  // Ни одно событие не осталось ждать следующего запуска, и сообщения дежурным стоят в очереди исходящих по всем обращениям.
  expect((await pools.root.query(`select count(*)::int as n from hdc_domain_events where processed_on is null`)).rows[0].n).toBe(0);
  const alerts = (await pools.root.query(`select ticket_id, min(created_on) as at from hdn_outbox where template = 'oncall_p1' group by ticket_id`)).rows;
  expect(alerts).toHaveLength(tickets.length);
  // Сообщение о первом обращении поставлено раньше, чем правило дошло до последнего: события разбирались между пачками.
  const lastRun = (await pools.root.query(`select max(created_on) as at from hdw_rule_runs where rule_id = $1`, [ruleId])).rows[0].at as Date;
  const firstAlert = alerts.map((row) => (row.at as Date).getTime()).sort((x, y) => x - y)[0] as number;
  expect(firstAlert).toBeLessThan(lastRun.getTime());
});
