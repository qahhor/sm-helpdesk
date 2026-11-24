import { PgBoss } from 'pg-boss';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { processEvents } from '@/modules/hdc/api';
import { MemoryJobQueue, setJobQueueForTests } from '@/modules/hdc/testing';
import { createTicket, getAgentTicket, postStaffMessage, rateTicket, replyToTicket, setPriority, ticketsMinute } from '@/modules/hdt/api';
import { BUILTIN_RULES, type BuiltinCode } from '@/modules/hdw/api';
import { handleRuleEvent, newRuleRun } from '@/modules/hdw/api/engine';
import { deleteRule, dryRunRule, listRules, readRule, restoreBuiltinRule, saveRule, setRuleEnabled } from '@/modules/hdw/api/rules';
import { startWorker } from '@/worker/main';
import { clientCtx, staffCtx } from './helpers/auth';
import { drainAutomation, seedBuiltinRules } from './helpers/automation';
import { appUrl, asActor, pools } from './helpers/db';
import { type Fixture, seedTwoOrgs } from './isolation/fixture';

// Предустановленные правила вместо встроенных уведомлений (FR-AUTO-12; план M8, задача 10, решения 1 и 2): дежурным о
// P1, руководителю линии о нарушении срока, Customer Care об оценке 1-2. Правило можно выключить и изменить, нельзя
// удалить; "Вернуть исходное" возвращает поставочный вид. Сами уведомления остались прежними: их проверяет
// staff-notify.test.ts с теми же ожиданиями, что до переноса.

const MINUTE = 60_000;
const MINUTE_JOB = { type: 'system', job: 'tickets.minute' } as const;
const AUTOMATION = { type: 'system', job: 'automation.process' } as const;
let f: Fixture;
let admin: ReturnType<typeof staffCtx>;

beforeEach(async () => {
  f = await seedTwoOrgs();
  admin = staffCtx(f.adminStaff);
  // Общая очистка перед тестом убирает строки миграции: правила возвращаются той же командой, что в миграции 0067.
  await seedBuiltinRules();
});
afterEach(() => setJobQueueForTests(null));

type RuleRow = { rule_id: string; name: string; event: string; hours: number | null; conditions: unknown; actions: unknown; order_no: number; is_stop: boolean; is_enabled: boolean; disabled_reason: string | null; pcode: string; enabled_on: Date | null };
const builtinRows = () => pools.root.query<RuleRow>(`select * from hdw_rules where pcode is not null order by order_no`).then((r) => r.rows);
const ruleId = async (pcode: BuiltinCode) => (await pools.root.query(`select rule_id from hdw_rules where pcode = $1`, [pcode])).rows[0].rule_id as string;
const outbox = (ticketId: string, template: string) =>
  pools.root
    .query(`select channel, recipient_kind, recipient_user_id, payload from hdn_outbox where ticket_id = $1 and template = $2 order by created_on, outbox_id`, [ticketId, template])
    .then((r) => r.rows);
const notices = (userId: string, kind: string, ticketId: string) =>
  pools.root.query(`select payload from hdn_notifications where user_id = $1 and kind = $2 and ticket_id = $3 order by created_on`, [userId, kind, ticketId]).then((r) => r.rows);
const runsOf = (pcode: BuiltinCode, ticketId: string) =>
  pools.root
    .query(`select r.result, r.actions_done from hdw_rule_runs r join hdw_rules x on x.rule_id = r.rule_id where x.pcode = $1 and r.ticket_id = $2 order by r.run_id`, [pcode, ticketId])
    .then((r) => r.rows);
const ticketIdOf = async (number: number) => (await pools.root.query(`select ticket_id from hdt_tickets where number = $1`, [number])).rows[0].ticket_id as string;
const auditOf = (objectId: string) => pools.root.query(`select action, actor_type, actor_id, diff from hdc_audit_log where object_id = $1 order by created_on, audit_id`, [objectId]).then((r) => r.rows);
const versionOf = async (number: number) => (await getAgentTicket(staffCtx(f.l1), number))?.version ?? '';

// Клиент организации Б в тестах: её администратор (bAdmin). Пользователя bUser задача раз в минуту переносит к
// пользователю организации А: в наборе изоляции для него записано слияние гостя.

/** Сроки обращения набора изоляции: набор заливается без сроков, их ставит смена приоритета сотрудником. */
async function withDeadlines(t: { ticketId: string; number: number }): Promise<{ first: Date; resolution: Date }> {
  await setPriority(staffCtx(f.care), { number: t.number, priority: 'p2', reason: 'Проверка' });
  const row = (await pools.root.query(`select first_response_due_on, resolution_due_on from hdt_tickets where ticket_id = $1`, [t.ticketId])).rows[0];
  return { first: row.first_response_due_on as Date, resolution: row.resolution_due_on as Date };
}

/** Новое обращение P1 от клиента организации. */
async function p1(member: { userId: string }): Promise<{ number: number; ticketId: string }> {
  const { number } = await createTicket(await clientCtx(member), { description: 'Склад стоит', type: 'bug', impact: 'blocker', locale: 'ru' });
  return { number, ticketId: await ticketIdOf(number) };
}
/** Обращение закрыто: клиент может поставить оценку. */
const close = (ticketId: string) => pools.root.query(`update hdt_tickets set status = 'closed', resolved_on = now(), closed_on = now(), sla_paused_on = now() where ticket_id = $1`, [ticketId]);

test('миграция поставляет три правила: включены, без момента включения, первыми по порядку, как в описании приложения', async () => {
  const rows = await builtinRows();
  expect(rows.map((row) => row.pcode)).toEqual(['p1_oncall', 'sla_breach_lead', 'csat_low_manager']);
  for (const [index, row] of rows.entries()) {
    const shipped = BUILTIN_RULES[row.pcode as BuiltinCode];
    expect({ name: row.name, event: row.event, hours: row.hours, conditions: row.conditions, actions: row.actions, is_stop: row.is_stop }, row.pcode).toEqual({
      name: shipped.name,
      event: shipped.event,
      hours: null,
      conditions: shipped.conditions,
      actions: shipped.actions,
      is_stop: shipped.isStop,
    });
    expect([row.order_no, row.is_enabled, row.disabled_reason, row.enabled_on], row.pcode).toEqual([index + 1, true, null, null]);
  }
  // Приложение читает их как годные правила; в списке администратора они видны.
  expect((await listRules(admin)).map((rule) => [rule.pcode, rule.isValid, rule.isEnabled])).toEqual([
    ['p1_oncall', true, true],
    ['sla_breach_lead', true, true],
    ['csat_low_manager', true, true],
  ]);
});

test('P1 от клиента: сообщение ставит система при разборе события; след в журнале срабатываний и аудита, история обращения прежняя', async () => {
  const t = await p1(f.aUser);
  // До разбора события сообщения нет и отметки нет: прямого вызова из создания обращения больше нет.
  expect(await outbox(t.ticketId, 'oncall_p1')).toEqual([]);
  expect((await pools.root.query(`select oncall_notified_on from hdt_tickets where ticket_id = $1`, [t.ticketId])).rows[0].oncall_notified_on).toBeNull();
  await drainAutomation();
  expect((await outbox(t.ticketId, 'oncall_p1')).map((row) => [row.channel, row.recipient_kind]).sort()).toEqual([['email', 'oncall'], ['telegram', 'oncall']]);
  expect((await pools.root.query(`select oncall_notified_on from hdt_tickets where ticket_id = $1`, [t.ticketId])).rows[0].oncall_notified_on).not.toBeNull();
  expect(await runsOf('p1_oncall', t.ticketId)).toEqual([{ result: 'applied', actions_done: [{ action: 'notify_oncall_p1', ok: true, from: null, to: 'oncall' }] }]);
  // Уведомление обращение не меняет и раньше записи в истории не оставляло: история обращения та же, что до переноса.
  expect((await pools.root.query(`select kind from hdt_ticket_events where ticket_id = $1 order by created_on, event_id`, [t.ticketId])).rows).toEqual([{ kind: 'created' }]);
  expect((await auditOf(t.ticketId)).filter((row) => row.action === 'rule.applied')).toMatchObject([
    { actor_type: 'system', diff: { ruleName: BUILTIN_RULES.p1_oncall.name, result: 'applied', actions: [{ action: 'notify_oncall_p1', ok: true }] } },
  ]);
  // Обращение не P1: правило не срабатывает вовсе.
  expect(await runsOf('p1_oncall', f.tickets.aOrg.ticketId)).toEqual([]);
});

test('выключенное предустановленное правило ничего не отправляет: ни дежурным, ни руководителю линии', async () => {
  await setRuleEnabled(admin, { ruleId: await ruleId('p1_oncall'), enabled: false });
  await setRuleEnabled(admin, { ruleId: await ruleId('sla_breach_lead'), enabled: false });
  await pools.root.query(`update hdu_staff set is_lead = true where user_id = $1`, [f.l1.userId]);
  const created = await p1(f.aUser);
  const raised = f.tickets.bOrg;
  await setPriority(staffCtx(f.l1), { number: raised.number, priority: 'p1', reason: 'Стоит склад' });
  const due = (await pools.root.query(`select first_response_due_on from hdt_tickets where ticket_id = $1`, [raised.ticketId])).rows[0].first_response_due_on as Date;
  expect(due).not.toBeNull();
  expect((await ticketsMinute(MINUTE_JOB, new Date(due.getTime() + MINUTE))).breached).toBeGreaterThan(0);
  await drainAutomation();
  expect(await outbox(created.ticketId, 'oncall_p1')).toEqual([]);
  expect(await outbox(raised.ticketId, 'oncall_p1')).toEqual([]);
  expect(await notices(f.l1.userId, 'sla_breach', raised.ticketId)).toEqual([]);
  expect(await outbox(raised.ticketId, 'staff_breach')).toEqual([]);
  // Отметка нарушения стоит: выключено только уведомление.
  expect((await pools.root.query(`select first_response_breached_on from hdt_tickets where ticket_id = $1`, [raised.ticketId])).rows[0].first_response_breached_on).not.toBeNull();
  // Включили обратно: новое обращение P1 снова даёт сообщение.
  await setRuleEnabled(admin, { ruleId: await ruleId('p1_oncall'), enabled: true });
  const next = await p1(f.bAdmin);
  await drainAutomation();
  expect(await outbox(next.ticketId, 'oncall_p1')).toHaveLength(2);
});

test('изменённое правило: с условием "категория организации A" дежурные получают сообщение только о подходящих обращениях', async () => {
  await pools.root.query(`update hdu_organizations set category = 'A' where org_id = $1`, [f.orgA.orgId]);
  const id = await ruleId('p1_oncall');
  const shipped = BUILTIN_RULES.p1_oncall;
  await saveRule(admin, {
    ruleId: id,
    name: shipped.name,
    event: shipped.event,
    conditions: { match: 'all', items: [...shipped.conditions.items, { field: 'org_category', op: 'is', values: ['A'] }] },
    actions: shipped.actions,
    isStop: false,
  });
  // Правка не выключила правило и не поставила момент включения.
  expect(await readRule(admin, id)).toMatchObject({ isEnabled: true, enabledOn: null, pcode: 'p1_oncall' });
  const a = await p1(f.aUser);
  const b = await p1(f.bAdmin);
  // Поднятие приоритета идёт тем же правилом: условие действует и там.
  await setPriority(staffCtx(f.l1), { number: f.tickets.bOrg.number, priority: 'p1', reason: 'Стоит склад' });
  await setPriority(staffCtx(f.l1), { number: f.tickets.aOrg.number, priority: 'p1', reason: 'Стоит склад' });
  await drainAutomation();
  expect(await outbox(a.ticketId, 'oncall_p1')).toHaveLength(2);
  expect(await outbox(f.tickets.aOrg.ticketId, 'oncall_p1')).toHaveLength(2);
  expect(await outbox(b.ticketId, 'oncall_p1')).toEqual([]);
  expect(await outbox(f.tickets.bOrg.ticketId, 'oncall_p1')).toEqual([]);
  expect(await runsOf('p1_oncall', b.ticketId)).toEqual([]);
});

test('администратор добавляет предустановленному правилу действие: оно выполняется вместе с уведомлением', async () => {
  const id = await ruleId('sla_breach_lead');
  await pools.root.query(`update hdu_staff set is_lead = true where user_id = $1`, [f.l1.userId]);
  await saveRule(admin, { ruleId: id, name: 'Нарушение срока: руководителю и заметка', event: 'sla_breached', conditions: { match: 'all', items: [] }, actions: [{ action: 'notify_sla_breach' }, { action: 'add_note', text: 'Срок нарушен: разберите причину' }] });
  const t = f.tickets.aOrg;
  const due = (await withDeadlines(t)).first;
  await ticketsMinute(MINUTE_JOB, new Date(due.getTime() + MINUTE));
  await drainAutomation();
  expect((await notices(f.l1.userId, 'sla_breach', t.ticketId)).map((n) => n.payload.breach)).toEqual(['first_response']);
  expect((await pools.root.query(`select body, is_internal, is_auto from hdt_ticket_messages where ticket_id = $1 and author_type = 'system'`, [t.ticketId])).rows).toEqual([
    { body: 'Срок нарушен: разберите причину', is_internal: true, is_auto: true },
  ]);
  // Правило сделало с обращением что-то кроме уведомления: в истории обращения появилась запись о правиле.
  const history = await pools.root.query(`select payload, is_internal, actor_type from hdt_ticket_events where ticket_id = $1 and kind = 'rule'`, [t.ticketId]);
  expect(history.rows).toMatchObject([{ is_internal: true, actor_type: 'system', payload: { ruleName: 'Нарушение срока: руководителю и заметка', actions: [{ action: 'notify_sla_breach', ok: true }, { action: 'add_note', ok: true }] } }]);
});

test('"Вернуть исходное": поставочный вид, включение и порядок не меняются, запись журнала; только администратор со свежим входом', async () => {
  const id = await ruleId('csat_low_manager');
  const shipped = BUILTIN_RULES.csat_low_manager;
  await saveRule(admin, { ruleId: id, name: 'Оценка 1', event: 'rated', conditions: { match: 'all', items: [{ field: 'rating', op: 'is', value: 1 }] }, actions: [{ action: 'add_note', text: 'Плохая оценка' }], isStop: true });
  await setRuleEnabled(admin, { ruleId: id, enabled: false });
  const stale = { ...admin, sessionCreatedAt: new Date(Date.now() - 901e3) };
  await expect(restoreBuiltinRule(stale, { ruleId: id })).rejects.toMatchObject({ code: 'stale_session' });
  await expect(restoreBuiltinRule(staffCtx(f.care), { ruleId: id })).rejects.toMatchObject({ code: 'forbidden' });
  await expect(restoreBuiltinRule(admin, { ruleId: 'не идентификатор' })).rejects.toMatchObject({ code: 'invalid_input' });
  await expect(restoreBuiltinRule(admin, { ruleId: '019a1111-1111-7111-8111-111111111111' })).rejects.toMatchObject({ code: 'not_found' });
  expect(await readRule(admin, id)).toMatchObject({ name: 'Оценка 1', isStop: true });
  await restoreBuiltinRule(admin, { ruleId: id });
  const restored = await readRule(admin, id);
  expect(restored).toMatchObject({ name: shipped.name, event: shipped.event, hours: null, conditions: shipped.conditions, isStop: false, isEnabled: false, orderNo: 3, pcode: 'csat_low_manager', isValid: true });
  expect(restored?.actions).toEqual(shipped.actions);
  const audit = await auditOf(id);
  expect(audit.map((row) => row.action)).toEqual(['rule.updated', 'rule.disabled', 'rule.restored']);
  expect(audit.at(-1)).toMatchObject({ actor_type: 'staff', actor_id: f.adminStaff.userId, diff: { pcode: 'csat_low_manager', was: 'Оценка 1', name: shipped.name, conditions: ['rating'], actions: ['notify_csat_low'] } });
  expect(JSON.stringify(audit.at(-1)?.diff)).not.toContain('Плохая оценка');
  // У обычного правила исходного вида нет.
  const own = await saveRule(admin, { name: 'Своё', event: 'ticket_created', conditions: { match: 'all', items: [] }, actions: [{ action: 'add_note', text: 'Заметка' }] });
  await expect(restoreBuiltinRule(admin, { ruleId: own.ruleId })).rejects.toMatchObject({ code: 'not_builtin' });
});

test('предустановленное правило нельзя удалить ни через api, ни прямо в базе администратором; код и событие не меняются', async () => {
  const id = await ruleId('p1_oncall');
  await expect(deleteRule(admin, { ruleId: id })).rejects.toMatchObject({ code: 'builtin_rule' });
  // Политика hdw_rules_admin_delete: строка с pcode администратору для удаления не видна.
  expect(await asActor(pools.app, f.adminStaff.actor, (c) => c.query(`delete from hdw_rules where rule_id = $1`, [id]).then((r) => r.rowCount))).toBe(0);
  expect(await asActor(pools.app, f.adminStaff.actor, (c) => c.query(`delete from hdw_rules where pcode is not null`).then((r) => r.rowCount))).toBe(0);
  // Код правила не снять и не сменить: триггер t_hdw_rules_guard.
  await expect(asActor(pools.app, f.adminStaff.actor, (c) => c.query(`update hdw_rules set pcode = null where rule_id = $1`, [id]))).rejects.toThrow(/не меняются/);
  await expect(asActor(pools.app, f.adminStaff.actor, (c) => c.query(`update hdw_rules set pcode = 'mine' where rule_id = $1`, [id]))).rejects.toThrow(/не меняются/);
  // Своё правило с кодом предустановленного администратор не вставит.
  await expect(
    asActor(pools.app, f.adminStaff.actor, (c) => c.query(`insert into hdw_rules (name, event, actions, order_no, pcode) values ('Чужое', 'rated', '[{"action": "notify_csat_low"}]', 50, 'mine')`)),
  ).rejects.toThrow(/row-level security/);
  // Система (фоновая задача) правило тоже не удаляет, клиент его не видит.
  expect(await asActor(pools.app, AUTOMATION, (c) => c.query(`delete from hdw_rules where rule_id = $1`, [id]).then((r) => r.rowCount))).toBe(0);
  expect(await asActor(pools.app, f.aUser.actor, (c) => c.query(`select count(*)::int as n from hdw_rules`).then((r) => r.rows[0].n))).toBe(0);
  expect(await builtinRows()).toHaveLength(3);
  // Событие предустановленного правила через api не меняется: на него завязано действие.
  const shipped = BUILTIN_RULES.p1_oncall;
  await expect(saveRule(admin, { ruleId: id, name: shipped.name, event: 'client_replied', conditions: shipped.conditions, actions: shipped.actions })).rejects.toMatchObject({
    code: 'invalid_input',
    issues: [{ path: 'event', code: 'builtin_event' }],
  });
});

test('действие предустановленного правила принимает только оно само: в обычном и в чужом предустановленном правиле отказ', async () => {
  const own = { name: 'Своё', event: 'ticket_created', conditions: { match: 'all', items: [] }, actions: [{ action: 'add_note', text: 'Заметка' }, { action: 'notify_oncall_p1' }] };
  await expect(saveRule(admin, own)).rejects.toMatchObject({ code: 'invalid_input', issues: [{ path: 'actions.1', code: 'builtin_only' }] });
  const breach = BUILTIN_RULES.sla_breach_lead;
  await expect(saveRule(admin, { ruleId: await ruleId('sla_breach_lead'), name: breach.name, event: breach.event, conditions: breach.conditions, actions: [{ action: 'notify_csat_low' }] })).rejects.toMatchObject({
    code: 'invalid_input',
    issues: [{ path: 'actions.0', code: 'builtin_only' }],
  });
  // Лишнее поле у действия без значения схема не принимает.
  await expect(saveRule(admin, { ...own, actions: [{ action: 'notify_oncall_p1', target: { kind: 'oncall' } }] })).rejects.toMatchObject({ code: 'invalid_input' });
  // Пробный прогон предустановленного правила описывает его действие и ничего не пишет.
  const p1Rule = BUILTIN_RULES.p1_oncall;
  await setPriority(staffCtx(f.l1), { number: f.tickets.aOrg.number, priority: 'p1', reason: 'Стоит склад' });
  const dry = await dryRunRule(admin, { name: p1Rule.name, event: p1Rule.event, conditions: p1Rule.conditions, actions: p1Rule.actions });
  expect(dry.matches.map((match) => [match.number, match.actions])).toEqual([[f.tickets.aOrg.number, [{ action: 'notify_oncall_p1', ok: true, to: 'oncall' }]]]);
  expect(await outbox(f.tickets.aOrg.ticketId, 'oncall_p1')).toEqual([]);
});

test('оценка 1 и 2: сотрудникам Customer Care уведомление и письмо без текста клиента; оценка 3 не уведомляет', async () => {
  const low = f.tickets.aOrg;
  const mid = f.tickets.bOrg;
  await close(low.ticketId);
  await close(mid.ticketId);
  await rateTicket(await clientCtx(f.aUser), { number: low.number, score: 2, reason: 'slow', comment: 'Долго отвечали, тайный комментарий' });
  await rateTicket(await clientCtx(f.bUser), { number: mid.number, score: 3, reason: 'other', comment: 'Средне' });
  await drainAutomation();
  expect((await notices(f.care.userId, 'csat_low', low.ticketId)).map((n) => n.payload)).toEqual([{ number: low.number, title: low.title, score: '2' }]);
  const mails = await outbox(low.ticketId, 'staff_csat_low');
  expect(mails.map((m) => [m.channel, m.recipient_kind, m.recipient_user_id])).toEqual([['email', 'user', f.care.userId]]);
  expect(mails[0]!.payload).toEqual({ template: 'staff_csat_low', number: low.number, title: low.title, url: `/agent/tickets/SUP-${low.number}`, score: 2, orgName: f.orgA.name });
  // Комментария и причины клиента нет ни в письме, ни в уведомлении, ни в журнале срабатываний.
  const everything = JSON.stringify([mails, await notices(f.care.userId, 'csat_low', low.ticketId), await runsOf('csat_low_manager', low.ticketId)]);
  expect(everything).not.toContain('тайный');
  expect(everything).not.toContain('slow');
  // Другие роли не получают; оценка 3 никого не уведомляет и срабатывания не даёт.
  expect(await notices(f.l1.userId, 'csat_low', low.ticketId)).toEqual([]);
  expect(await notices(f.adminStaff.userId, 'csat_low', low.ticketId)).toEqual([]);
  expect(await notices(f.care.userId, 'csat_low', mid.ticketId)).toEqual([]);
  expect(await outbox(mid.ticketId, 'staff_csat_low')).toEqual([]);
  expect(await runsOf('csat_low_manager', mid.ticketId)).toEqual([]);
  expect(await runsOf('csat_low_manager', low.ticketId)).toEqual([{ result: 'applied', actions_done: [{ action: 'notify_csat_low', ok: true, from: null, to: '2' }] }]);
});

test('оценка 1 тоже уведомляет; без сотрудников Customer Care срабатывание записано невыполненным', async () => {
  const t = f.tickets.aOrg;
  await close(t.ticketId);
  await pools.root.query(`update hdu_staff set role = 'agent_l2' where user_id = $1`, [f.care.userId]);
  await rateTicket(await clientCtx(f.aUser), { number: t.number, score: 1, reason: 'not_solved' });
  await drainAutomation();
  expect(await runsOf('csat_low_manager', t.ticketId)).toEqual([{ result: 'failed', actions_done: [{ action: 'notify_csat_low', ok: false, detail: 'no_recipients' }] }]);
  expect(await outbox(t.ticketId, 'staff_csat_low')).toEqual([]);
});

test('приоритет поднят правилом администратора: дежурные извещены, хотя событие порождено правилом; правила администратора на него не срабатывают', async () => {
  const raise = await saveRule(admin, { name: 'Ответ клиента поднимает до P1', event: 'client_replied', conditions: { match: 'all', items: [] }, actions: [{ action: 'set_priority', priority: 'p1' }] });
  const chained = await saveRule(admin, { name: 'На смену приоритета заметка', event: 'priority_changed', conditions: { match: 'all', items: [] }, actions: [{ action: 'add_note', text: 'Цепочка' }] });
  await setRuleEnabled(admin, { ruleId: raise.ruleId, enabled: true });
  await setRuleEnabled(admin, { ruleId: chained.ruleId, enabled: true });
  const t = f.tickets.aOrg;
  await replyToTicket(await clientCtx(f.aUser), { number: t.number, body: 'Всё стоит' });
  await drainAutomation();
  expect((await pools.root.query(`select priority from hdt_tickets where ticket_id = $1`, [t.ticketId])).rows[0].priority).toBe('p1');
  expect(await outbox(t.ticketId, 'oncall_p1')).toHaveLength(2);
  // Правило администратора на событие, порождённое правилом, не сработало (FR-AUTO-07).
  expect((await pools.root.query(`select count(*)::int as n from hdw_rule_runs where rule_id = $1`, [chained.ruleId])).rows[0].n).toBe(0);
});

test('на событие, порождённое правилом, у предустановленного правила выполняется только его уведомление', async () => {
  const id = await ruleId('p1_oncall');
  const shipped = BUILTIN_RULES.p1_oncall;
  await saveRule(admin, { ruleId: id, name: shipped.name, event: shipped.event, conditions: shipped.conditions, actions: [{ action: 'notify_oncall_p1' }, { action: 'add_note', text: 'P1: проверьте' }] });
  const t = f.tickets.aOrg;
  // Событие смены приоритета с отметкой "порождено правилом", как его пишет действие правила или макроса.
  await pools.root.query(`update hdt_tickets set priority = 'p1' where ticket_id = $1`, [t.ticketId]);
  await pools.root.query(`insert into hdc_domain_events (org_id, ticket_id, kind, is_by_rule, payload) values ($1, $2, 'priority_changed', true, '{"from": "p3", "to": "p1"}')`, [f.orgA.orgId, t.ticketId]);
  await drainAutomation();
  expect(await runsOf('p1_oncall', t.ticketId)).toEqual([{ result: 'applied', actions_done: [{ action: 'notify_oncall_p1', ok: true, from: null, to: 'oncall' }] }]);
  expect((await pools.root.query(`select count(*)::int as n from hdt_ticket_messages where ticket_id = $1 and author_type = 'system'`, [t.ticketId])).rows[0].n).toBe(0);
  // На событие сотрудника выполняются оба действия.
  const created = await p1(f.bAdmin);
  await drainAutomation();
  expect((await runsOf('p1_oncall', created.ticketId))[0].actions_done.map((item: { action: string }) => item.action)).toEqual(['notify_oncall_p1', 'add_note']);
});

test('приоритет двенадцать раз за час подняли до P1 и опустили: сообщение одно, защита от зацикливания правило не выключает', async () => {
  const t = f.tickets.aOrg;
  const l1 = staffCtx(f.l1);
  for (let round = 0; round < 12; round++) {
    await setPriority(l1, { number: t.number, priority: 'p1', reason: 'Стоит склад' });
    await drainAutomation();
    await setPriority(l1, { number: t.number, priority: 'p2', reason: 'Заработало' });
    await drainAutomation();
  }
  await setPriority(l1, { number: t.number, priority: 'p1', reason: 'Стоит склад' });
  await drainAutomation();
  expect(await outbox(t.ticketId, 'oncall_p1')).toHaveLength(2);
  const runs = await runsOf('p1_oncall', t.ticketId);
  // Первое срабатывание отправило сообщение, остальные записаны как "менять нечего" и в счёт защиты не идут.
  expect(runs).toHaveLength(13);
  expect(runs.map((run) => run.result)).toEqual(Array.from({ length: 13 }, () => 'applied'));
  expect(runs.slice(1).every((run) => run.actions_done[0].unchanged === true)).toBe(true);
  expect(await readRule(admin, await ruleId('p1_oncall'))).toMatchObject({ isEnabled: true, disabledReason: null });
  // Другое обращение P1 после этого по-прежнему даёт сообщение.
  const next = await p1(f.bAdmin);
  await drainAutomation();
  expect(await outbox(next.ticketId, 'oncall_p1')).toHaveLength(2);
});

test('P1 после первого ответа: правило сработало, менять нечего, сообщения нет', async () => {
  const t = f.tickets.aOrg;
  await postStaffMessage(staffCtx(f.l1), { number: t.number, body: 'Смотрим', internal: false, seenVersion: await versionOf(t.number) });
  await setPriority(staffCtx(f.l1), { number: t.number, priority: 'p1', reason: 'Стоит склад' });
  await drainAutomation();
  expect(await outbox(t.ticketId, 'oncall_p1')).toEqual([]);
  expect(await runsOf('p1_oncall', t.ticketId)).toEqual([{ result: 'applied', actions_done: [{ action: 'notify_oncall_p1', ok: true, unchanged: true }] }]);
});

test('нарушение срока: по уведомлению на каждый срок, правило выполнено на событии своего срока', async () => {
  await pools.root.query(`update hdu_staff set is_lead = true where user_id = $1`, [f.l1.userId]);
  const t = f.tickets.aOrg;
  const due = await withDeadlines(t);
  await ticketsMinute(MINUTE_JOB, new Date(due.first.getTime() + MINUTE));
  await drainAutomation();
  await ticketsMinute(MINUTE_JOB, new Date(due.resolution.getTime() + MINUTE));
  await drainAutomation();
  expect((await notices(f.l1.userId, 'sla_breach', t.ticketId)).map((n) => n.payload.breach)).toEqual(['first_response', 'resolution']);
  expect((await outbox(t.ticketId, 'staff_breach')).map((m) => [m.recipient_user_id, m.payload.kind])).toEqual([
    [f.l1.userId, 'first_response'],
    [f.l1.userId, 'resolution'],
  ]);
  expect((await runsOf('sla_breach_lead', t.ticketId)).map((run) => run.result)).toEqual(['applied', 'applied']);
});

test('сбой разбора события пять раз подряд: событие снято, проверка состояния портала разбужена сразу', async () => {
  const jobs = new MemoryJobQueue();
  setJobQueueForTests(jobs);
  const t = await p1(f.aUser);
  jobs.sent.length = 0;
  const run = newRuleRun();
  const broken = async (tx: Parameters<typeof handleRuleEvent>[0], event: Parameters<typeof handleRuleEvent>[1]) => {
    await handleRuleEvent(tx, event, run);
    throw new Error('база недоступна');
  };
  for (let attempt = 1; attempt <= 5; attempt++) expect(await processEvents(AUTOMATION, broken)).toEqual({ processed: 0, failed: 1 });
  // Сообщение дежурным о P1 не поставлено: транзакция события откатывалась целиком.
  expect(await outbox(t.ticketId, 'oncall_p1')).toEqual([]);
  expect((await pools.root.query(`select attempts, processed_on is not null as dropped from hdc_domain_events where ticket_id = $1`, [t.ticketId])).rows).toEqual([{ attempts: 5, dropped: true }]);
  // Задача ops.watch поставлена один раз, в момент снятия события: дежурные узнают о потере, не дожидаясь расписания.
  expect(jobs.sent.filter((job) => job.name === 'ops.watch')).toHaveLength(1);
});

test('задержка сообщения дежурным о P1 через фоновый процесс: от создания обращения до строки очереди исходящих', async () => {
  await pools.owner.query('delete from pgboss.job');
  // Настройки фонового процесса как в рабочем окружении: опрос очереди задач раз в 2 секунды.
  const worker = await startWorker({ connectionString: appUrl, schedules: false });
  const delays: number[] = [];
  try {
    for (let sample = 0; sample < 5; sample++) {
      const started = performance.now();
      const t = await p1(sample % 2 === 0 ? f.aUser : f.bAdmin);
      const committed = performance.now();
      for (;;) {
        if ((await outbox(t.ticketId, 'oncall_p1')).length === 2) break;
        if (performance.now() - committed > 20_000) throw new Error('сообщение дежурным не поставлено за 20 секунд');
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      delays.push(Math.round(performance.now() - committed));
      void started;
      await pools.root.query(`delete from hdc_rate_limits`);
    }
  } finally {
    await worker.stop();
    // Фоновый процесс при запуске заводит служебную очередь расписаний pg-boss. Тест её убирает: набор очередей
    // после него тот же, что после миграций (его сверяет worker.test.ts).
    const owner = new PgBoss({ connectionString: process.env.DATABASE_URL_OWNER, schema: 'pgboss', supervise: false, schedule: false, migrate: false });
    owner.on('error', () => {});
    await owner.start();
    try {
      for (const queue of await owner.getQueues()) if (queue.name.startsWith('__pgboss__')) await owner.deleteQueue(queue.name);
    } finally {
      await owner.stop({ graceful: false });
    }
    await pools.owner.query('delete from pgboss.job');
  }
  const sorted = [...delays].sort((x, y) => x - y);
  // Числа попадают в отчёт задачи: файл в каталоге, который задаёт переменная окружения (необязательно).
  if (process.env.P1_DELAY_REPORT) (await import('node:fs')).writeFileSync(process.env.P1_DELAY_REPORT, JSON.stringify({ delays, min: sorted[0], median: sorted[2], max: sorted[4] }));
  // Сообщение приходит по сигналу после фиксации, а не по расписанию раз в минуту: один цикл опроса очереди задач.
  expect(sorted[4]).toBeLessThan(10_000);
}, 120_000);
