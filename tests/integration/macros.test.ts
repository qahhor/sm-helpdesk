import { beforeEach, expect, test } from 'vitest';
import { processEvents } from '@/modules/hdc/api';
import { getAgentTicket, getTicket, loadDraft, saveDraft, setStatus } from '@/modules/hdt/api';
import { handleRuleEvent, newRuleRun } from '@/modules/hdw/api/engine';
import { deleteMacro, listMacros, listRunnableMacros, macroOptions, moveMacro, readMacro, runMacro, saveMacro } from '@/modules/hdw/api/macros';
import { saveRule, setRuleEnabled } from '@/modules/hdw/api/rules';
import { clientCtx, staffCtx, staffWithRole } from './helpers/auth';
import { asActor, pools } from './helpers/db';
import { type Fixture, seedTwoOrgs } from './isolation/fixture';

// Макросы (FR-AG-15, UX-A-16, FR-ADM-10; план M8, задача 6, решение 7). Макрос создаёт администратор из того же
// набора действий, что у правил, кроме вебхука, распределения по кругу и уведомления. Выполняется он от имени
// сотрудника и с его правами: каждое действие идёт через то же действие обращения, что и ручное. Ответ по шаблону
// макрос не отправляет, а возвращает текст для поля ответа.

const SYSTEM = { type: 'system', job: 'automation.process' } as const;
const ID = '019a1111-1111-7111-8111-111111111111';
let f: Fixture;
let admin: ReturnType<typeof staffCtx>;
let l1: ReturnType<typeof staffCtx>;

beforeEach(async () => {
  f = await seedTwoOrgs();
  admin = staffCtx(f.adminStaff);
  l1 = staffCtx(f.l1);
});

const tag = (name: string) => pools.root.query(`insert into hdr_tags (name) values ($1) returning tag_id`, [name]).then((r) => r.rows[0].tag_id as string);
const template = (body: Record<string, string>, enabled = true) =>
  pools.root
    .query(`insert into hdr_reply_templates (shortcut, title, body, is_enabled) values ($1, 'Запрос версии', $2, $3) returning template_id`, [`t${Math.random().toString(36).slice(2, 10)}`, JSON.stringify(body), enabled])
    .then((r) => r.rows[0].template_id as string);
const ticketRow = (ticketId: string) => pools.root.query(`select * from hdt_tickets where ticket_id = $1`, [ticketId]).then((r) => r.rows[0]);
const history = (ticketId: string, kind?: string) =>
  pools.root
    .query(`select kind, actor_type, actor_id, payload, is_internal from hdt_ticket_events where ticket_id = $1 and kind <> 'created' ${kind ? `and kind = '${kind}'` : ''} order by created_on, event_id`, [ticketId])
    .then((r) => r.rows);
const messagesOf = (ticketId: string) =>
  pools.root.query(`select author_type, author_id, body, is_internal, is_auto from hdt_ticket_messages where ticket_id = $1 order by created_on, message_id`, [ticketId]).then((r) => r.rows);
const auditOf = (objectId: string, action?: string) =>
  pools.root.query(`select action, actor_type, actor_id, diff from hdc_audit_log where object_id = $1 ${action ? `and action = '${action}'` : ''} order by created_on, audit_id`, [objectId]).then((r) => r.rows);
const domainEvents = (ticketId: string) =>
  pools.root.query(`select kind, is_by_rule from hdc_domain_events where ticket_id = $1 order by event_id`, [ticketId]).then((r) => r.rows);
/** Макрос через слой api. */
async function macro(name: string, actions: unknown[], isEnabled = true): Promise<string> {
  return (await saveMacro(admin, { name, actions, isEnabled })).macroId;
}

test('администратор создаёт, правит, переставляет и удаляет макрос: каждое изменение с записью журнала без текстов', async () => {
  const tagId = await tag('VIP');
  const templateId = await template({ ru: 'Пришлите версию' });
  const { macroId } = await saveMacro(admin, {
    name: 'Запросить версию и скриншот',
    actions: [{ action: 'reply_template', templateId }, { action: 'set_status', status: 'waiting_customer' }, { action: 'add_note', text: 'Секретный текст заметки' }, { action: 'add_tag', tagId }, { action: 'assign_me' }],
  });
  const second = await macro('Второй', [{ action: 'set_priority', priority: 'p1' }], false);
  expect((await listMacros(admin)).map((m) => [m.macroId, m.name, m.orderNo, m.isEnabled, m.isValid])).toEqual([
    [macroId, 'Запросить версию и скриншот', 1, true, true],
    [second, 'Второй', 2, false, true],
  ]);
  expect(await readMacro(admin, macroId)).toMatchObject({
    macroId,
    name: 'Запросить версию и скриншот',
    isEnabled: true,
    actions: [{ action: 'reply_template', templateId }, { action: 'set_status', status: 'waiting_customer' }, { action: 'add_note', text: 'Секретный текст заметки' }, { action: 'add_tag', tagId }, { action: 'assign_me' }],
  });
  await saveMacro(admin, { macroId, name: 'Запросить версию', actions: [{ action: 'reply_template', templateId }], isEnabled: false });
  expect(await readMacro(admin, macroId)).toMatchObject({ name: 'Запросить версию', isEnabled: false, orderNo: 1 });
  await moveMacro(admin, { macroId: second, direction: 'up' });
  expect((await listMacros(admin)).map((m) => [m.name, m.orderNo])).toEqual([['Второй', 1], ['Запросить версию', 2]]);
  await deleteMacro(admin, { macroId: second });
  expect((await listMacros(admin)).map((m) => m.name)).toEqual(['Запросить версию']);
  const audit = await auditOf(macroId);
  expect(audit.map((x) => x.action)).toEqual(['macro.created', 'macro.updated']);
  expect(audit[0]).toMatchObject({ actor_type: 'staff', actor_id: f.adminStaff.userId, diff: { name: 'Запросить версию и скриншот', actions: ['reply_template', 'set_status', 'add_note', 'add_tag', 'assign_me'], isEnabled: true } });
  expect(JSON.stringify(audit)).not.toContain('Секретный');
  expect((await auditOf(second)).map((x) => x.action)).toEqual(['macro.created', 'macro.moved', 'macro.deleted']);
  expect(await readMacro(admin, 'не идентификатор')).toBeNull();
  expect(await readMacro(admin, ID)).toBeNull();
  for (const call of [() => saveMacro(admin, { macroId: ID, name: 'Нет', actions: [{ action: 'assign_me' }] }), () => moveMacro(admin, { macroId: ID, direction: 'up' }), () => deleteMacro(admin, { macroId: ID })])
    await expect(call()).rejects.toMatchObject({ code: 'not_found' });
  // Списки для редактора: вебхуков, распределения по кругу и уведомлений в них нет.
  const options = await macroOptions(admin);
  expect(options.actions).toEqual(['set_queue', 'assign', 'set_priority', 'add_tag', 'remove_tag', 'add_note', 'reply_template', 'snooze', 'set_status']);
  expect(options.queues).toEqual(['l1', 'l2']);
  expect(options.tags.map((item) => item.name)).toEqual(['VIP']);
});

test('схема макроса: от 1 до 10 действий, вебхук, распределение по кругу и уведомление не принимаются, ссылки проверяются', async () => {
  const good = { name: 'Макрос', actions: [{ action: 'assign_me' }] };
  const product = await staffWithRole('product');
  for (const [name, bad] of [
    ['нет действий', { ...good, actions: [] }],
    ['одиннадцать действий', { ...good, actions: Array.from({ length: 11 }, () => ({ action: 'assign_me' })) }],
    ['вебхук', { ...good, actions: [{ action: 'webhook', endpointId: ID }] }],
    ['по кругу', { ...good, actions: [{ action: 'assign_round_robin' }] }],
    ['уведомление', { ...good, actions: [{ action: 'notify', target: { kind: 'oncall' } }] }],
    ['очередь care', { ...good, actions: [{ action: 'set_queue', queue: 'care' }] }],
    ['статус "Решено"', { ...good, actions: [{ action: 'set_status', status: 'resolved' }] }],
    ['лишнее поле', { ...good, script: 'x' }],
    ['пустое название', { ...good, name: ' ' }],
    ['событие и условия правила', { ...good, event: 'ticket_created', conditions: { match: 'all', items: [] } }],
  ] as const)
    await expect(saveMacro(admin, bad), name).rejects.toMatchObject({ code: 'invalid_input' });
  await expect(
    saveMacro(admin, { ...good, actions: [{ action: 'add_tag', tagId: ID }, { action: 'reply_template', templateId: ID }, { action: 'assign', userId: ID }, { action: 'assign', userId: product.userId }, { action: 'assign', userId: f.l1.userId }] }),
  ).rejects.toMatchObject({
    code: 'invalid_input',
    issues: [
      { path: 'actions.0.tagId', code: 'reference_missing' },
      { path: 'actions.1.templateId', code: 'reference_missing' },
      { path: 'actions.2.userId', code: 'reference_missing' },
      { path: 'actions.3.userId', code: 'reference_missing' },
    ],
  });
  expect((await pools.root.query(`select count(*)::int as n from hdw_macros`)).rows[0].n).toBe(0);
});

test('макросы ведёт только администратор со свежим входом; читают сотрудники; клиент не видит ничего', async () => {
  const macroId = await macro('Макрос', [{ action: 'assign_me' }]);
  const hidden = await macro('Выключен', [{ action: 'assign_me' }], false);
  const input = { name: 'Чужой', actions: [{ action: 'assign_me' }] };
  const stale = { ...admin, sessionCreatedAt: new Date(Date.now() - 901e3) };
  const writes: [string, (ctx: typeof admin) => Promise<unknown>][] = [
    ['создание', (ctx) => saveMacro(ctx, input)],
    ['правка', (ctx) => saveMacro(ctx, { ...input, macroId })],
    ['порядок', (ctx) => moveMacro(ctx, { macroId, direction: 'down' })],
    ['удаление', (ctx) => deleteMacro(ctx, { macroId })],
  ];
  for (const [name, call] of writes) await expect(call(stale), name).rejects.toMatchObject({ code: 'stale_session' });
  for (const role of ['agent_l1', 'agent_l2', 'care', 'product'] as const) {
    const member = await staffWithRole(role);
    const ctx = staffCtx(member);
    for (const [name, call] of writes) await expect(call(ctx), `${role}: ${name}`).rejects.toMatchObject({ code: 'forbidden' });
    await expect(listMacros(ctx), role).rejects.toMatchObject({ code: 'forbidden' });
    await expect(macroOptions(ctx), role).rejects.toMatchObject({ code: 'forbidden' });
    // Включённые макросы видит тот, кто ведёт обращения; роль product обращений не ведёт и макросов не запускает.
    expect((await listRunnableMacros(ctx)).map((m) => m.name), role).toEqual(role === 'product' ? [] : ['Макрос']);
    // Политики базы: сотрудник читает, но не пишет.
    expect((await asActor(pools.app, member.actor, (c) => c.query(`select 1 from hdw_macros`))).rowCount).toBe(2);
    await expect(asActor(pools.app, member.actor, (c) => c.query(`insert into hdw_macros (name, actions, order_no) values ('Чужой', '[{"action": "assign_me"}]', 9)`))).rejects.toThrow(/row-level security/);
    expect((await asActor(pools.app, member.actor, (c) => c.query(`update hdw_macros set name = 'Чужой'`))).rowCount).toBe(0);
    expect((await asActor(pools.app, member.actor, (c) => c.query(`delete from hdw_macros`))).rowCount).toBe(0);
  }
  // Система макросы не читает и не пишет: макрос запускает только человек.
  expect((await asActor(pools.app, SYSTEM, (c) => c.query(`select 1 from hdw_macros`))).rowCount).toBe(0);
  await expect(asActor(pools.app, SYSTEM, (c) => c.query(`insert into hdw_macros (name, actions, order_no) values ('Система', '[{"action": "assign_me"}]', 9)`))).rejects.toThrow(/row-level security/);
  for (const member of [f.aUser, f.aAdmin]) {
    expect((await asActor(pools.app, member.actor, (c) => c.query(`select 1 from hdw_macros`))).rowCount).toBe(0);
    await expect(asActor(pools.app, member.actor, (c) => c.query(`insert into hdw_macros (name, actions, order_no) values ('Клиент', '[{"action": "assign_me"}]', 9)`))).rejects.toThrow(/row-level security/);
  }
  const client = await clientCtx(f.aUser);
  await expect(listMacros(client as never)).rejects.toMatchObject({ code: 'forbidden' });
  expect(await listRunnableMacros(client as never)).toEqual([]);
  await expect(runMacro(client as never, { ticketNumber: f.tickets.aOrg.number, macroId })).rejects.toMatchObject({ code: 'forbidden' });
  expect(hidden).not.toBe(macroId);
});

test('агент первой линии запускает макрос: действие, которого ему нельзя, получает forbidden, остальные выполняются', async () => {
  const t = f.tickets.aOrg;
  const tagId = await tag('Ждём версию');
  const macroId = await macro('Передать разработке', [
    // "В разработке" ставят вторая линия, care и admin (DEVELOPMENT_ROLES): первой линии нельзя.
    { action: 'set_status', status: 'in_development' },
    { action: 'add_tag', tagId },
    { action: 'add_note', text: 'Клиент ждёт исправления' },
    { action: 'set_priority', priority: 'p1' },
    { action: 'assign_me' },
    { action: 'snooze', hours: 24 },
    // Вернуть на первую линию может только вторая линия; обращение и так на первой: менять нечего.
    { action: 'set_queue', queue: 'l1' },
  ]);
  // Из "В работе" переход "В разработке" есть в таблице 7.2: отказ первой линии это отказ по роли, а не по переходу.
  await setStatus(l1, { number: t.number, to: 'in_progress' });
  const before = Date.now();
  const result = await runMacro(l1, { ticketNumber: t.number, macroId });
  expect(result.macroName).toBe('Передать разработке');
  expect(result.template).toBeNull();
  expect(result.actions).toEqual([
    { action: 'set_status', ok: false, detail: 'forbidden' },
    { action: 'add_tag', ok: true, from: null, to: 'Ждём версию' },
    { action: 'add_note', ok: true },
    { action: 'set_priority', ok: true, from: 'p2', to: 'p1' },
    { action: 'assign', ok: true, to: f.l1.name },
    { action: 'snooze', ok: true, to: expect.stringMatching(/^\d{4}-/) },
    { action: 'set_queue', ok: true, from: 'l1', to: 'l1', unchanged: true },
  ]);
  const row = await ticketRow(t.ticketId);
  expect(row).toMatchObject({ status: 'in_progress', priority: 'p1', priority_confirmed: true, assignee_id: f.l1.userId, queue: 'l1' });
  expect(new Date(row.snoozed_until).getTime()).toBeGreaterThanOrEqual(before + 24 * 3_600_000 - 1000);
  // Действия выполнены самим сотрудником: заметка его, события истории его, как при ручных действиях.
  expect((await messagesOf(t.ticketId)).at(-1)).toMatchObject({ author_type: 'staff', author_id: f.l1.userId, body: 'Клиент ждёт исправления', is_internal: true, is_auto: false });
  expect((await history(t.ticketId, 'priority'))[0]).toMatchObject({ actor_type: 'staff', actor_id: f.l1.userId, payload: { from: 'p2', to: 'p1', reason: 'Передать разработке' } });
  expect((await pools.root.query(`select added_by from hdt_ticket_tags where ticket_id = $1 and tag_id = $2`, [t.ticketId, tagId])).rows).toEqual([{ added_by: f.l1.userId }]);
  // Одна внутренняя запись истории на запуск макроса и запись журнала аудита.
  const runs = await history(t.ticketId, 'rule');
  expect(runs).toHaveLength(1);
  expect(runs[0]).toMatchObject({ actor_type: 'staff', actor_id: f.l1.userId, is_internal: true, payload: { macro: true, macroId, ruleName: 'Передать разработке' } });
  expect(runs[0].payload.actions).toEqual(result.actions);
  const audit = await auditOf(t.ticketId, 'macro.run');
  expect(audit).toMatchObject([{ actor_type: 'staff', actor_id: f.l1.userId, diff: { macroId, macroName: 'Передать разработке', result: 'partial' } }]);
  expect(JSON.stringify(audit)).not.toContain('Клиент ждёт');
  // Сотруднику второй линии тот же макрос ставит "В разработке".
  const l2 = staffCtx(await staffWithRole('agent_l2'));
  const second = await runMacro(l2, { ticketNumber: t.number, macroId });
  expect(second.actions[0]).toEqual({ action: 'set_status', ok: true, from: 'in_progress', to: 'in_development' });
  // Тег уже стоит, приоритет тот же: менять нечего.
  expect(second.actions[1]).toEqual({ action: 'add_tag', ok: true, from: 'Ждём версию', to: 'Ждём версию', unchanged: true });
  expect(second.actions[3]).toEqual({ action: 'set_priority', ok: true, from: 'p1', to: 'p1', unchanged: true });
  expect((await ticketRow(t.ticketId)).status).toBe('in_development');
  expect(await history(t.ticketId, 'rule')).toHaveLength(2);
});

test('переходы и права те же, что у ручных действий: запрещённый переход, передача между линиями, удалённые ссылки', async () => {
  const t = f.tickets.aOrg;
  const tagId = await tag('Временный');
  const gone = await staffWithRole('agent_l1');
  const macroId = await macro('Разное', [
    // Закрыть сотрудник может только решённое.
    { action: 'set_status', status: 'closed' },
    { action: 'remove_tag', tagId },
    { action: 'add_tag', tagId },
    { action: 'assign', userId: gone.userId },
    { action: 'set_queue', queue: 'l2' },
  ]);
  await pools.root.query(`delete from hdr_tags where tag_id = $1`, [tagId]);
  await pools.root.query(`update hdu_staff set state = 'passive' where user_id = $1`, [gone.userId]);
  const result = await runMacro(l1, { ticketNumber: t.number, macroId });
  expect(result.actions).toEqual([
    { action: 'set_status', ok: false, detail: 'transition_refused' },
    { action: 'remove_tag', ok: false, detail: 'tag_missing' },
    { action: 'add_tag', ok: false, detail: 'tag_missing' },
    { action: 'assign', ok: false, detail: 'user_missing' },
    // Передача на вторую линию идёт действием сотрудника: строка передачи с его именем, записка называет макрос.
    { action: 'set_queue', ok: true, from: 'l1', to: 'l2' },
  ]);
  expect((await ticketRow(t.ticketId)).queue).toBe('l2');
  expect((await pools.root.query(`select from_line, to_line, by_user, reason_code, checked from hdt_ticket_line_transfers where ticket_id = $1`, [t.ticketId])).rows).toEqual([
    { from_line: 'l1', to_line: 'l2', by_user: f.l1.userId, reason_code: 'other', checked: 'Разное' },
  ]);
  // Вернуть на первую линию агент первой линии не может: макрос не даёт больше прав, чем у него есть.
  const back = await macro('Вернуть', [{ action: 'set_queue', queue: 'l1' }]);
  expect((await runMacro(l1, { ticketNumber: t.number, macroId: back })).actions).toEqual([{ action: 'set_queue', ok: false, detail: 'forbidden' }]);
  expect((await auditOf(t.ticketId, 'macro.run')).map((x) => x.diff.result)).toEqual(['partial', 'failed']);
  const l2 = staffCtx(await staffWithRole('agent_l2'));
  expect((await runMacro(l2, { ticketNumber: t.number, macroId: back })).actions).toEqual([{ action: 'set_queue', ok: true, from: 'l2', to: 'l1' }]);
  expect((await ticketRow(t.ticketId)).queue).toBe('l1');
});

test('роль product макросы не запускает; выключенный, негодный и несуществующий макрос не выполняется', async () => {
  const t = f.tickets.aOrg;
  const macroId = await macro('Срочно', [{ action: 'set_priority', priority: 'p1' }]);
  const off = await macro('Выключен', [{ action: 'set_priority', priority: 'p1' }], false);
  const product = staffCtx(await staffWithRole('product'));
  await expect(runMacro(product, { ticketNumber: t.number, macroId })).rejects.toMatchObject({ code: 'forbidden' });
  await expect(runMacro(l1, { ticketNumber: t.number, macroId: off })).rejects.toMatchObject({ code: 'not_found' });
  await expect(runMacro(l1, { ticketNumber: t.number, macroId: ID })).rejects.toMatchObject({ code: 'not_found' });
  await expect(runMacro(l1, { ticketNumber: 999_999, macroId })).rejects.toMatchObject({ code: 'not_found' });
  await expect(runMacro(l1, { ticketNumber: 'x', macroId })).rejects.toMatchObject({ code: 'invalid_input' });
  await expect(runMacro(l1, { ticketNumber: t.number, macroId, as: f.adminStaff.userId })).rejects.toMatchObject({ code: 'invalid_input' });
  // Действия в базе испортили в обход схемы: макрос не выполняется и в списке запуска не показывается.
  await pools.root.query(`update hdw_macros set actions = '[{"action": "eval", "code": "1"}]' where macro_id = $1`, [macroId]);
  await expect(runMacro(l1, { ticketNumber: t.number, macroId })).rejects.toMatchObject({ code: 'not_found' });
  expect(await listRunnableMacros(l1)).toEqual([]);
  expect((await listMacros(admin)).find((m) => m.macroId === macroId)).toMatchObject({ isValid: false, actions: [] });
  expect(await ticketRow(t.ticketId)).toMatchObject({ priority: 'p2', status: 'new' });
  expect(await history(t.ticketId, 'rule')).toEqual([]);
});

test('события действий макроса помечены как порождённые правилом: правила на макрос не срабатывают', async () => {
  const t = f.tickets.aOrg;
  const noteRule = async (event: string) => {
    const { ruleId } = await saveRule(admin, { name: `На ${event}`, event, conditions: { match: 'all', items: [] }, actions: [{ action: 'add_note', text: 'Правило сработало' }] });
    await setRuleEnabled(admin, { ruleId, enabled: true });
    return ruleId;
  };
  await noteRule('status_changed');
  await noteRule('priority_changed');
  const drain = () => {
    const run = newRuleRun();
    return processEvents(SYSTEM, (tx, event) => handleRuleEvent(tx, event, run));
  };
  const macroId = await macro('Срочно в работу', [{ action: 'set_status', status: 'in_progress' }, { action: 'set_priority', priority: 'p1' }]);
  const result = await runMacro(l1, { ticketNumber: t.number, macroId });
  expect(result.actions.map((item) => item.ok)).toEqual([true, true]);
  expect(await domainEvents(t.ticketId)).toEqual([
    { kind: 'status_changed', is_by_rule: true },
    { kind: 'priority_changed', is_by_rule: true },
  ]);
  expect(await drain()).toMatchObject({ processed: 2, failed: 0 });
  expect((await pools.root.query(`select count(*)::int as n from hdw_rule_runs`)).rows[0].n).toBe(0);
  expect((await messagesOf(t.ticketId)).filter((m) => m.is_auto)).toEqual([]);
  // То же действие руками правило запускает: отметку ставит только серверный код макроса, из ввода она не читается.
  await setStatus(l1, { number: t.number, to: 'waiting_customer', byMacro: true, byRule: true });
  expect((await domainEvents(t.ticketId)).at(-1)).toEqual({ kind: 'status_changed', is_by_rule: false });
  await drain();
  expect((await pools.root.query(`select result from hdw_rule_runs`)).rows).toEqual([{ result: 'applied' }]);
});

test('ответ по шаблону макрос не отправляет: возвращает текст на языке обращения, сообщения клиенту нет', async () => {
  const t = f.tickets.aOrg;
  const templateId = await template({ ru: 'Пришлите, пожалуйста, версию и снимок экрана.', en: 'Please send the version and a screenshot.' });
  const disabled = await template({ ru: 'Выключенный' }, false);
  const macroId = await macro('Запросить версию и скриншот', [{ action: 'reply_template', templateId }, { action: 'set_status', status: 'waiting_customer' }, { action: 'reply_template', templateId: disabled }]);
  const before = await messagesOf(t.ticketId);
  const outboxBefore = (await pools.root.query(`select count(*)::int as n from hdn_outbox where template = 'ticket_reply'`)).rows[0].n;
  const result = await runMacro(l1, { ticketNumber: t.number, macroId });
  expect(result.actions).toEqual([
    { action: 'reply_template', ok: true, to: 'Запрос версии' },
    { action: 'set_status', ok: true, from: 'new', to: 'waiting_customer' },
    { action: 'reply_template', ok: false, detail: 'template_disabled' },
  ]);
  expect(result.template).toEqual({ text: 'Пришлите, пожалуйста, версию и снимок экрана.', fallback: false });
  expect((await ticketRow(t.ticketId)).status).toBe('waiting_customer');
  // Ничего не отправлено: переписка та же, письма об ответе нет, срок первого ответа не остановлен.
  expect(await messagesOf(t.ticketId)).toEqual(before);
  expect((await pools.root.query(`select count(*)::int as n from hdn_outbox where template = 'ticket_reply'`)).rows[0].n).toBe(outboxBefore);
  expect((await ticketRow(t.ticketId)).first_responded_on).toBeNull();
  expect((await domainEvents(t.ticketId)).map((e) => e.kind)).toEqual(['status_changed']);
  // Язык обращения: есть перевод, берётся он; нет перевода, берётся русский текст с отметкой для агента.
  await pools.root.query(`update hdt_tickets set locale = 'en' where ticket_id = $1`, [f.tickets.aMine.ticketId]);
  const only = await macro('Только шаблон', [{ action: 'reply_template', templateId }]);
  expect((await runMacro(l1, { ticketNumber: f.tickets.aMine.number, macroId: only })).template).toEqual({ text: 'Please send the version and a screenshot.', fallback: false });
  await pools.root.query(`update hdt_tickets set locale = 'uz' where ticket_id = $1`, [f.tickets.aMine.ticketId]);
  expect((await runMacro(l1, { ticketNumber: f.tickets.aMine.number, macroId: only })).template).toEqual({ text: 'Пришлите, пожалуйста, версию и снимок экрана.', fallback: true });
  // Черновик сотрудника макрос с заметкой не стирает.
  await saveDraft(l1, { number: t.number, body: 'Начатый ответ', internal: false });
  const withNote = await macro('Заметка', [{ action: 'add_note', text: 'Проверить оплату' }]);
  await runMacro(l1, { ticketNumber: t.number, macroId: withNote });
  expect(await loadDraft(l1, t.number)).toMatchObject({ body: 'Начатый ответ', internal: false });
});

test('клиент не видит ни записи о макросе, ни его названия; сотрудник видит одну запись на запуск', async () => {
  const t = f.tickets.aOrg;
  const macroId = await macro('Секретный макрос', [{ action: 'set_status', status: 'in_progress' }, { action: 'add_note', text: 'Заметка макроса' }]);
  await runMacro(l1, { ticketNumber: t.number, macroId });
  const client = await clientCtx(f.aUser);
  const view = await getTicket(client, t.number);
  expect(JSON.stringify(view)).not.toContain('Секретный макрос');
  expect(JSON.stringify(view)).not.toContain('Заметка макроса');
  expect(JSON.stringify(view)).not.toContain('macro');
  // Смену статуса клиент видит, как при ручном действии сотрудника.
  expect(view?.status).toBe('in_progress');
  for (const member of [f.aUser, f.aAdmin]) {
    const rows = await asActor(pools.app, member.actor, (c) => c.query(`select kind, payload from hdt_ticket_events where ticket_id = $1`, [t.ticketId]));
    expect(rows.rows.filter((row) => row.kind === 'rule')).toEqual([]);
    expect(JSON.stringify(rows.rows)).not.toContain('Секретный макрос');
  }
  // Запись о макросе нельзя сделать видимой клиенту: ограничение базы.
  await expect(pools.root.query(`update hdt_ticket_events set is_internal = false where ticket_id = $1 and kind = 'rule'`, [t.ticketId])).rejects.toThrow(/hdt_ticket_events_c3/);
  const agent = await getAgentTicket(l1, t.number);
  const entries = agent?.timeline.filter((entry) => entry.type === 'event' && entry.kind === 'rule') ?? [];
  expect(entries).toHaveLength(1);
  expect(entries[0]).toMatchObject({ isInternal: true, actorName: f.l1.name, payload: { macro: true, ruleName: 'Секретный макрос' } });
});

test('шаблон макроса не вставляется в черновик внутренней заметки: заметка цела и осталась заметкой, действие записано отказом (проверка M8, I3)', async () => {
  const t = f.tickets.aOrg;
  const templateId = await template({ ru: 'Пришлите, пожалуйста, версию и снимок экрана.' });
  const macroId = await macro('Запросить версию', [{ action: 'reply_template', templateId }, { action: 'set_priority', priority: 'p3' }]);
  // Сотрудник пишет внутреннюю заметку: черновик сохранён как заметка.
  await saveDraft(l1, { number: t.number, body: 'Клиент должен за два месяца, не обещать сроков', internal: true });
  const result = await runMacro(l1, { ticketNumber: t.number, macroId });
  expect(result.actions).toEqual([
    { action: 'reply_template', ok: false, detail: 'draft_is_note' },
    { action: 'set_priority', ok: true, from: 'p2', to: 'p3' },
  ]);
  expect(result.template).toBeNull();
  expect(await loadDraft(l1, t.number)).toMatchObject({ body: 'Клиент должен за два месяца, не обещать сроков', internal: true });
  // В истории обращения запись о макросе не говорит, что шаблон вставлен.
  const history = (await pools.root.query(`select payload from hdt_ticket_events where ticket_id = $1 and kind = 'rule' order by created_on desc limit 1`, [t.ticketId])).rows[0].payload;
  expect(history.actions).toEqual(result.actions);

  // Черновик публичного ответа: шаблон дописан после него, черновик остаётся публичным.
  await saveDraft(l1, { number: t.number, body: 'Здравствуйте!', internal: false });
  const only = await macro('Только шаблон 2', [{ action: 'reply_template', templateId }]);
  const second = await runMacro(l1, { ticketNumber: t.number, macroId: only });
  expect(second.actions).toEqual([{ action: 'reply_template', ok: true, to: 'Запрос версии' }]);
  expect(second.template).toEqual({ text: 'Пришлите, пожалуйста, версию и снимок экрана.', fallback: false });
  expect(await loadDraft(l1, t.number)).toMatchObject({ body: 'Здравствуйте!\n\nПришлите, пожалуйста, версию и снимок экрана.', internal: false });
  // Черновика нет: шаблон становится черновиком ответа.
  expect(await loadDraft(l1, f.tickets.aMine.number)).toBeNull();
  await runMacro(l1, { ticketNumber: f.tickets.aMine.number, macroId: only });
  expect(await loadDraft(l1, f.tickets.aMine.number)).toMatchObject({ body: 'Пришлите, пожалуйста, версию и снимок экрана.', internal: false });
});
