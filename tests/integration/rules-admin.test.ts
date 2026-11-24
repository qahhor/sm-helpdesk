import { beforeEach, expect, test } from 'vitest';
import { deleteRule, dryRunRule, listRuleRuns, listRules, moveRule, readRule, ruleOptions, saveRule, setRuleEnabled } from '@/modules/hdw/api/rules';
import { clientCtx, staffCtx, staffWithRole } from './helpers/auth';
import { asActor, pools } from './helpers/db';
import { type Fixture, seedTwoOrgs } from './isolation/fixture';

// Правила автоматизации глазами администратора (FR-AUTO-01, 05, 06, 08, FR-ADM-10; план M8, задача 3, решения 2 и 6):
// создание и правка со свежим входом, порядок, пробный прогон, журнал срабатываний. Клиент не видит ничего из hdw.

const ID = '019a1111-1111-7111-8111-111111111111';
let f: Fixture;
let admin: ReturnType<typeof staffCtx>;

beforeEach(async () => {
  f = await seedTwoOrgs();
  admin = staffCtx(f.adminStaff);
});

const base = { name: 'Срочные в Customer Care', event: 'ticket_created', conditions: { match: 'all', items: [{ field: 'priority', op: 'is', values: ['p1'] }] }, actions: [{ action: 'set_queue', queue: 'care' }] };
const auditOf = (objectId: string) => pools.root.query(`select action, actor_type, actor_id, diff from hdc_audit_log where object_id = $1 order by created_on, audit_id`, [objectId]).then((r) => r.rows);
const ruleRows = () => pools.root.query(`select rule_id, name, order_no, is_enabled, pcode from hdw_rules order by order_no, rule_id`).then((r) => r.rows);
const tag = (name: string) => pools.root.query(`insert into hdr_tags (name) values ($1) returning tag_id`, [name]).then((r) => r.rows[0].tag_id as string);
const builtin = () =>
  pools.root
    .query(`insert into hdw_rules (name, event, actions, order_no, pcode, is_enabled) values ('P1 дежурным', 'ticket_created', '[{"action": "notify", "target": {"kind": "oncall"}}]', 100, 'oncall_p1', true) returning rule_id`)
    .then((r) => r.rows[0].rule_id as string);

test('администратор создаёт правило: оно выключено, стоит последним, запись в журнале без текстов', async () => {
  const { ruleId } = await saveRule(admin, { ...base, actions: [...base.actions, { action: 'add_note', text: 'Секретный текст заметки' }] });
  const second = await saveRule(admin, { ...base, name: 'Второе', event: 'no_activity', hours: 48 });
  expect((await ruleRows()).map((r) => [r.rule_id, r.order_no, r.is_enabled, r.pcode])).toEqual([
    [ruleId, 1, false, null],
    [second.ruleId, 2, false, null],
  ]);
  const saved = await readRule(admin, ruleId);
  expect(saved).toMatchObject({ ruleId, name: base.name, event: 'ticket_created', hours: null, isStop: false, isEnabled: false, disabledReason: null, pcode: null, isValid: true, conditions: base.conditions });
  expect(saved?.actions).toEqual([{ action: 'set_queue', queue: 'care' }, { action: 'add_note', text: 'Секретный текст заметки' }]);
  expect((await listRules(admin)).map((r) => [r.name, r.hours])).toEqual([[base.name, null], ['Второе', 48]]);
  const [created] = await auditOf(ruleId);
  expect(created).toMatchObject({ action: 'rule.created', actor_type: 'staff', actor_id: f.adminStaff.userId, diff: { name: base.name, event: 'ticket_created', conditions: ['priority'], actions: ['set_queue', 'add_note'] } });
  expect(JSON.stringify(created.diff)).not.toContain('Секретный');
  expect(await readRule(admin, 'не идентификатор')).toBeNull();
  expect(await readRule(admin, ID)).toBeNull();
});

test('правка, включение, порядок и удаление: каждое действие с записью журнала', async () => {
  const a = await saveRule(admin, base);
  const b = await saveRule(admin, { ...base, name: 'Б' });
  const c = await saveRule(admin, { ...base, name: 'В' });
  await setRuleEnabled(admin, { ruleId: a.ruleId, enabled: true });
  // Правка не меняет включение и порядок.
  await saveRule(admin, { ...base, ruleId: a.ruleId, name: 'А новое', isStop: true });
  expect(await readRule(admin, a.ruleId)).toMatchObject({ name: 'А новое', isStop: true, isEnabled: true, orderNo: 1 });
  // Повторное включение уже включённого ничего не пишет.
  await setRuleEnabled(admin, { ruleId: a.ruleId, enabled: true });
  await moveRule(admin, { ruleId: c.ruleId, direction: 'up' });
  expect((await listRules(admin)).map((r) => r.name)).toEqual(['А новое', 'В', 'Б']);
  await moveRule(admin, { ruleId: c.ruleId, direction: 'up' });
  await moveRule(admin, { ruleId: c.ruleId, direction: 'up' });
  expect((await listRules(admin)).map((r) => [r.name, r.orderNo])).toEqual([['В', 1], ['А новое', 2], ['Б', 3]]);
  await moveRule(admin, { ruleId: c.ruleId, direction: 'down' });
  expect((await listRules(admin)).map((r) => r.name)).toEqual(['А новое', 'В', 'Б']);
  await setRuleEnabled(admin, { ruleId: a.ruleId, enabled: false });
  await deleteRule(admin, { ruleId: b.ruleId });
  expect((await listRules(admin)).map((r) => r.name)).toEqual(['А новое', 'В']);
  expect((await auditOf(a.ruleId)).map((x) => x.action)).toEqual(['rule.created', 'rule.enabled', 'rule.updated', 'rule.disabled']);
  // Сдвиг на краю списка порядок не меняет и в журнал не пишется.
  expect((await auditOf(c.ruleId)).map((x) => x.action)).toEqual(['rule.created', 'rule.moved', 'rule.moved', 'rule.moved']);
  expect((await auditOf(b.ruleId)).map((x) => x.action)).toEqual(['rule.created', 'rule.deleted']);
  for (const call of [() => saveRule(admin, { ...base, ruleId: ID }), () => setRuleEnabled(admin, { ruleId: ID, enabled: true }), () => moveRule(admin, { ruleId: ID, direction: 'up' }), () => deleteRule(admin, { ruleId: ID })])
    await expect(call()).rejects.toMatchObject({ code: 'not_found' });
});

test('схема: правило с неподдержанным событием, условием или лишним полем не сохраняется, отказ называет поле и код', async () => {
  await expect(saveRule(admin, { ...base, event: 'ai_handoff' })).rejects.toMatchObject({ code: 'invalid_input', issues: [{ path: 'event', code: 'event_not_ready' }] });
  await expect(saveRule(admin, { ...base, conditions: { match: 'all', items: [{ field: 'known_problem', op: 'is', value: true }] } })).rejects.toMatchObject({
    code: 'invalid_input',
    issues: [{ path: 'conditions.items.0', code: 'condition_not_ready' }],
  });
  await expect(saveRule(admin, { ...base, event: 'no_activity' })).rejects.toMatchObject({ code: 'invalid_input', issues: [{ path: 'hours', code: 'hours_required' }] });
  await expect(saveRule(admin, { ...base, script: 'x' })).rejects.toMatchObject({ code: 'invalid_input' });
  await expect(saveRule(admin, { ...base, actions: [{ action: 'eval', code: '1' }] })).rejects.toMatchObject({ code: 'invalid_input' });
  await expect(setRuleEnabled(admin, { ruleId: 'x', enabled: true })).rejects.toMatchObject({ code: 'invalid_input' });
  await expect(moveRule(admin, { ruleId: ID, direction: 'sideways' })).rejects.toMatchObject({ code: 'invalid_input' });
  expect(await ruleRows()).toEqual([]);
});

test('ссылки проверяются при сохранении: несуществующие тег, шаблон, сотрудник, модуль и организация отклоняются с путём', async () => {
  const tagId = await tag('VIP');
  const product = await staffWithRole('product');
  const rule = {
    ...base,
    conditions: {
      match: 'any',
      items: [
        { field: 'org', op: 'is', values: [f.orgA.orgId, ID] },
        { field: 'module', op: 'is', values: [null, ID] },
        { field: 'tags', op: 'has_any', values: [tagId, ID] },
        { field: 'tags', op: 'has_none', values: [tagId] },
      ],
    },
    actions: [
      { action: 'add_tag', tagId: ID },
      { action: 'remove_tag', tagId },
      { action: 'reply_template', templateId: ID },
      { action: 'assign', userId: ID },
      // Роль product обращений не ведёт: исполнителем её сотрудник не становится, но уведомить его можно.
      { action: 'assign', userId: product.userId },
      { action: 'notify', target: { kind: 'user', userId: product.userId } },
      { action: 'notify', target: { kind: 'user', userId: f.aUser.userId } },
      { action: 'webhook', endpointId: ID },
    ],
  };
  const error = await saveRule(admin, rule).then(
    () => null,
    (e: { code: string; issues: { path: string; code: string }[] }) => e,
  );
  expect(error?.code).toBe('invalid_input');
  expect(error?.issues.map((i) => [i.path, i.code]).sort()).toEqual(
    [
      ['conditions.items.0.values', 'reference_missing'],
      ['conditions.items.1.values', 'reference_missing'],
      ['conditions.items.2.values', 'reference_missing'],
      ['actions.0.tagId', 'reference_missing'],
      ['actions.2.templateId', 'reference_missing'],
      ['actions.3.userId', 'reference_missing'],
      ['actions.4.userId', 'reference_missing'],
      ['actions.6.target.userId', 'reference_missing'],
    ].sort(),
  );
  expect(await ruleRows()).toEqual([]);
  // С настоящими ссылками правило сохраняется.
  const templateId = (await pools.root.query(`insert into hdr_reply_templates (shortcut, title, body) values ('ask', 'Запрос версии', '{"ru": "Пришлите версию"}') returning template_id`)).rows[0].template_id;
  const moduleId = (await pools.root.query(`insert into hdr_product_modules (code, name) values ('orders', '{"ru": "Заказы"}') returning module_id`)).rows[0].module_id;
  await expect(
    saveRule(admin, {
      ...base,
      conditions: { match: 'all', items: [{ field: 'org', op: 'is', values: [f.orgA.orgId] }, { field: 'module', op: 'is', values: [null, moduleId] }, { field: 'tags', op: 'has_any', values: [tagId] }] },
      actions: [{ action: 'add_tag', tagId }, { action: 'reply_template', templateId }, { action: 'assign', userId: f.l1.userId }, { action: 'notify', target: { kind: 'user', userId: product.userId } }],
    }),
  ).resolves.toMatchObject({ ruleId: expect.any(String) });
});

test('права: правила читает и меняет только администратор со свежим входом', async () => {
  const { ruleId } = await saveRule(admin, base);
  for (const member of [f.l1, f.care, await staffWithRole('agent_l2'), await staffWithRole('product')]) {
    const ctx = staffCtx(member);
    const calls = [
      () => listRules(ctx),
      () => readRule(ctx, ruleId),
      () => saveRule(ctx, base),
      () => saveRule(ctx, { ...base, ruleId }),
      () => setRuleEnabled(ctx, { ruleId, enabled: true }),
      () => moveRule(ctx, { ruleId, direction: 'up' }),
      () => deleteRule(ctx, { ruleId }),
      () => listRuleRuns(ctx, { ruleId }),
      () => dryRunRule(ctx, base),
      () => ruleOptions(ctx),
    ];
    for (const call of calls) await expect(call(), member.actor.staffRole).rejects.toMatchObject({ code: 'forbidden' });
  }
  const stale = { ...admin, sessionCreatedAt: new Date(Date.now() - 901e3) };
  for (const call of [() => saveRule(stale, base), () => setRuleEnabled(stale, { ruleId, enabled: true }), () => moveRule(stale, { ruleId, direction: 'down' }), () => deleteRule(stale, { ruleId })])
    await expect(call()).rejects.toMatchObject({ code: 'stale_session' });
  // Чтение и пробный прогон свежего входа не требуют.
  await expect(listRules(stale)).resolves.toHaveLength(1);
  await expect(dryRunRule(stale, base)).resolves.toMatchObject({ checked: 5 });
  expect(await ruleRows()).toMatchObject([{ rule_id: ruleId, is_enabled: false }]);
});

test('права в базе: клиент не видит правил и срабатываний, сотрудник без роли администратора правила не пишет', async () => {
  const { ruleId } = await saveRule(admin, base);
  const builtinId = await builtin();
  await pools.root.query(`insert into hdw_rule_runs (org_id, rule_id, ticket_id, result) values ($1, $2, $3, 'applied'), ($4, $2, $5, 'applied')`, [f.orgA.orgId, ruleId, f.tickets.aOrg.ticketId, f.orgB.orgId, f.tickets.bOrg.ticketId]);
  for (const actor of [f.aUser.actor, f.aAdmin.actor, f.bAdmin.actor]) {
    for (const table of ['hdw_rules', 'hdw_rule_runs']) expect((await asActor(pools.app, actor, (c) => c.query(`select * from ${table}`))).rowCount, table).toBe(0);
    await expect(asActor(pools.app, actor, (c) => c.query(`insert into hdw_rules (name, event, actions, order_no) values ('Клиент', 'rated', '[]', 9)`))).rejects.toThrow(/row-level security/);
    expect((await asActor(pools.app, actor, (c) => c.query(`update hdw_rules set is_enabled = true`))).rowCount).toBe(0);
    expect((await asActor(pools.app, actor, (c) => c.query(`delete from hdw_rules`))).rowCount).toBe(0);
    await expect(asActor(pools.app, actor, (c) => c.query(`insert into hdw_rule_runs (org_id, rule_id, ticket_id, result) values ($1, $2, $3, 'applied')`, [f.orgA.orgId, ruleId, f.tickets.aOrg.ticketId]))).rejects.toThrow(/row-level security/);
    expect((await asActor(pools.app, actor, (c) => c.query(`delete from hdw_rule_runs`))).rowCount).toBe(0);
  }
  // Сотрудники читают правила и срабатывания (история обращения называет правило), пишет только администратор.
  for (const member of [f.l1, f.care]) {
    expect((await asActor(pools.app, member.actor, (c) => c.query(`select 1 from hdw_rules`))).rowCount).toBe(2);
    expect((await asActor(pools.app, member.actor, (c) => c.query(`select 1 from hdw_rule_runs`))).rowCount).toBe(2);
    await expect(asActor(pools.app, member.actor, (c) => c.query(`insert into hdw_rules (name, event, actions, order_no) values ('Агент', 'rated', '[]', 9)`))).rejects.toThrow(/row-level security/);
    expect((await asActor(pools.app, member.actor, (c) => c.query(`update hdw_rules set is_enabled = true`))).rowCount).toBe(0);
    expect((await asActor(pools.app, member.actor, (c) => c.query(`delete from hdw_rules`))).rowCount).toBe(0);
    await expect(asActor(pools.app, member.actor, (c) => c.query(`insert into hdw_rule_runs (org_id, rule_id, ticket_id, result) values ($1, $2, $3, 'applied')`, [f.orgA.orgId, ruleId, f.tickets.aOrg.ticketId]))).rejects.toThrow(/row-level security/);
    expect((await asActor(pools.app, member.actor, (c) => c.query(`delete from hdw_rule_runs`))).rowCount).toBe(0);
  }
  // Администратор: срабатывания не пишет и не удаляет, предустановленное правило не создаёт, не удаляет и код не меняет.
  const adminActor = f.adminStaff.actor;
  await expect(asActor(pools.app, adminActor, (c) => c.query(`insert into hdw_rule_runs (org_id, rule_id, ticket_id, result) values ($1, $2, $3, 'applied')`, [f.orgA.orgId, ruleId, f.tickets.aOrg.ticketId]))).rejects.toThrow(/row-level security/);
  expect((await asActor(pools.app, adminActor, (c) => c.query(`delete from hdw_rule_runs`))).rowCount).toBe(0);
  await expect(asActor(pools.app, adminActor, (c) => c.query(`insert into hdw_rules (name, event, actions, order_no, pcode) values ('Подделка', 'rated', '[]', 9, 'fake_builtin')`))).rejects.toThrow(/row-level security/);
  expect((await asActor(pools.app, adminActor, (c) => c.query(`delete from hdw_rules where rule_id = $1`, [builtinId]))).rowCount).toBe(0);
  await expect(asActor(pools.app, adminActor, (c) => c.query(`update hdw_rules set pcode = null where rule_id = $1`, [builtinId]))).rejects.toThrow(/код предустановленного правила не меняются/);
  await expect(asActor(pools.app, adminActor, (c) => c.query(`update hdw_rules set pcode = 'mine' where rule_id = $1`, [ruleId]))).rejects.toThrow(/код предустановленного правила не меняются/);
  // Система: только выключает правило. Включить, переименовать или поменять действия она не может.
  const system = { type: 'system', job: 'automation.process' } as const;
  await expect(asActor(pools.app, system, (c) => c.query(`update hdw_rules set actions = '[]' where rule_id = $1`, [builtinId]))).rejects.toThrow(/система меняет только включение/);
  await expect(asActor(pools.app, system, (c) => c.query(`update hdw_rules set name = 'Другое' where rule_id = $1`, [builtinId]))).rejects.toThrow(/система меняет только включение/);
  await expect(asActor(pools.app, system, (c) => c.query(`update hdw_rules set is_enabled = true where rule_id = $1`, [ruleId]))).rejects.toThrow(/row-level security/);
  await expect(asActor(pools.app, system, (c) => c.query(`insert into hdw_rules (name, event, actions, order_no) values ('Система', 'rated', '[]', 9)`))).rejects.toThrow(/row-level security/);
  expect((await asActor(pools.app, system, (c) => c.query(`delete from hdw_rules`))).rowCount).toBe(0);
  expect((await asActor(pools.app, system, (c) => c.query(`update hdw_rules set is_enabled = false, disabled_reason = 'loop' where rule_id = $1`, [builtinId]))).rowCount).toBe(1);
  // Пробный прогон в журнал срабатываний не пишется ни одним актором.
  await expect(asActor(pools.app, system, (c) => c.query(`insert into hdw_rule_runs (org_id, rule_id, ticket_id, result, is_dry_run) values ($1, $2, $3, 'applied', true)`, [f.orgA.orgId, ruleId, f.tickets.aOrg.ticketId]))).rejects.toThrow(/row-level security/);
  // Клиенту недоступны и точки входа: контекст клиента не контекст сотрудника.
  const client = await clientCtx(f.aUser);
  await expect(listRules(client as never)).rejects.toMatchObject({ code: 'forbidden' });
});

test('предустановленное правило: можно изменить и выключить, удалить нельзя (решение 2)', async () => {
  const ruleId = await builtin();
  await expect(deleteRule(admin, { ruleId })).rejects.toMatchObject({ code: 'builtin_rule' });
  await saveRule(admin, { ...base, ruleId, name: 'P1 дежурным и руководителю' });
  await setRuleEnabled(admin, { ruleId, enabled: false });
  expect(await ruleRows()).toMatchObject([{ rule_id: ruleId, name: 'P1 дежурным и руководителю', is_enabled: false, pcode: 'oncall_p1' }]);
  expect(await readRule(admin, ruleId)).toMatchObject({ pcode: 'oncall_p1' });
});

test('пробный прогон: на каких из последних обращений условия выполнены и что сделали бы действия; в базе ничего не меняется', async () => {
  const tagId = await tag('VIP');
  await pools.root.query(`update hdu_organizations set category = 'A' where org_id = $1`, [f.orgA.orgId]);
  await pools.root.query(`update hdt_tickets set priority = 'p1', status = 'in_progress', assignee_id = $2 where ticket_id = $1`, [f.tickets.aMine.ticketId, f.care.userId]);
  await pools.root.query(`update hdt_tickets set status = 'closed' where ticket_id = $1`, [f.tickets.aPrivate.ticketId]);
  const rule = {
    name: 'Клиенты категории A',
    event: 'ticket_created',
    conditions: { match: 'all', items: [{ field: 'org_category', op: 'is', values: ['A'] }] },
    actions: [
      { action: 'set_priority', priority: 'p1' },
      { action: 'set_queue', queue: 'l2' },
      { action: 'assign', userId: f.l1.userId },
      { action: 'add_tag', tagId },
      { action: 'set_status', status: 'waiting_customer' },
      { action: 'reply_template', templateId: ID },
      { action: 'add_note', text: 'Заметка' },
    ],
  };
  const counts = async () => {
    const tables = (await pools.root.query(`select tablename from pg_tables where schemaname = 'public' and tablename <> 'hdc_audit_log' order by 1`)).rows.map((r) => r.tablename as string);
    const out: Record<string, number> = {};
    for (const name of tables) out[name] = (await pools.root.query(`select count(*)::int as n from ${name}`)).rows[0].n;
    return out;
  };
  const stamps = () => pools.root.query(`select ticket_id, modified_on, status, priority, queue, assignee_id from hdt_tickets order by ticket_id`).then((r) => JSON.stringify(r.rows));
  const before = { counts: await counts(), stamps: await stamps(), audit: (await pools.root.query(`select count(*)::int as n from hdc_audit_log`)).rows[0].n as number };

  const result = await dryRunRule(admin, rule);
  expect(result).toMatchObject({ checked: 5, count: 3 });
  // От новых обращений к старым: aMine, aPrivate, aOrg (номера растут с созданием).
  expect(result.matches.map((m) => m.number)).toEqual([f.tickets.aMine.number, f.tickets.aPrivate.number, f.tickets.aOrg.number]);
  expect(result.matches.every((m) => m.orgName === 'ACME Trade')).toBe(true);
  const [mine, closed, org] = result.matches;
  expect(org).toMatchObject({ priority: 'p2' });
  expect(org?.actions).toEqual([
    { action: 'set_priority', ok: true, from: 'p2', to: 'p1' },
    { action: 'set_queue', ok: true, from: 'l1', to: 'l2' },
    { action: 'assign', ok: true, from: null, to: f.l1.name },
    { action: 'add_tag', ok: true, from: null, to: 'VIP' },
    { action: 'set_status', ok: true, from: 'new', to: 'waiting_customer' },
    { action: 'reply_template', ok: false, detail: 'template_missing' },
    { action: 'add_note', ok: true },
  ]);
  expect(mine).toMatchObject({ priority: 'p1' });
  expect(mine?.actions.slice(0, 3)).toEqual([
    { action: 'set_priority', ok: true, from: 'p1', to: 'p1', unchanged: true },
    { action: 'set_queue', ok: true, from: 'l1', to: 'l2' },
    { action: 'assign', ok: true, from: f.care.name, to: f.l1.name },
  ]);
  // Закрытое обращение: очередь и статус правило не сменило бы.
  expect(closed?.actions.filter((a) => !a.ok).map((a) => [a.action, a.detail])).toEqual([
    ['set_queue', 'transition_refused'],
    ['set_status', 'transition_refused'],
    ['reply_template', 'template_missing'],
  ]);

  // Ничего не изменилось: число строк во всех таблицах, время изменения и поля обращений прежние.
  expect(await counts()).toEqual(before.counts);
  expect(await stamps()).toBe(before.stamps);
  // Единственная запись: журнал аудита о самом прогоне.
  const audit = (await pools.root.query(`select action, actor_id, object_type, object_id, diff from hdc_audit_log order by created_on desc, audit_id desc limit 1`)).rows[0];
  expect((await pools.root.query(`select count(*)::int as n from hdc_audit_log`)).rows[0].n).toBe(before.audit + 1);
  expect(audit).toMatchObject({ action: 'rule.dry_run', actor_id: f.adminStaff.userId, object_type: 'rule', object_id: null, diff: { name: 'Клиенты категории A', event: 'ticket_created', checked: 5, matched: 3 } });

  // Негодное правило не прогоняется; правило без совпадений возвращает пустой список.
  await expect(dryRunRule(admin, { ...rule, event: 'ai_handoff' })).rejects.toMatchObject({ code: 'invalid_input' });
  expect(await dryRunRule(admin, { ...rule, conditions: { match: 'all', items: [{ field: 'rating', op: 'lte', value: 2 }] } })).toEqual({ checked: 5, count: 0, matches: [] });
});

test('пробный прогон берёт только последние 100 обращений', async () => {
  await pools.root.query(
    `insert into hdt_tickets (org_id, author_id, type, impact, priority, visibility, title, description, locale, source)
     select $1, $2, 'question', 'minor', 'p3', 'org', 'Обращение ' || n, 'Описание', 'ru', 'portal' from generate_series(1, 120) n`,
    [f.orgB.orgId, f.bUser.userId],
  );
  const result = await dryRunRule(admin, { ...base, conditions: { match: 'all', items: [] } });
  expect(result).toMatchObject({ checked: 100, count: 100 });
  // Обращения набора созданы раньше ста последних: в прогон не попали.
  expect(result.matches.map((m) => m.number)).not.toContain(f.tickets.aOrg.number);
});

test('журнал срабатываний правила: новые сверху, по страницам, с номером обращения', async () => {
  const { ruleId } = await saveRule(admin, base);
  const other = await saveRule(admin, { ...base, name: 'Другое' });
  await pools.root.query(
    `insert into hdw_rule_runs (org_id, rule_id, ticket_id, result, actions_done, created_on)
     select $1, $2, $3, case when n % 7 = 0 then 'partial' else 'applied' end, '[{"action": "set_queue", "ok": true, "from": "l1", "to": "care"}]', now() - make_interval(mins => n)
       from generate_series(1, 120) n`,
    [f.orgA.orgId, ruleId, f.tickets.aOrg.ticketId],
  );
  await pools.root.query(`insert into hdw_rule_runs (org_id, rule_id, ticket_id, result) values ($1, $2, $3, 'failed')`, [f.orgB.orgId, other.ruleId, f.tickets.bOrg.ticketId]);
  const first = await listRuleRuns(admin, { ruleId });
  expect(first.items).toHaveLength(50);
  expect(first.items[0]).toMatchObject({ ticketNumber: f.tickets.aOrg.number, result: 'applied', eventId: null, actions: [{ action: 'set_queue', ok: true, from: 'l1', to: 'care' }] });
  const second = await listRuleRuns(admin, { ruleId, cursor: first.nextCursor });
  const third = await listRuleRuns(admin, { ruleId, cursor: second.nextCursor });
  expect([second.items.length, third.items.length, third.nextCursor]).toEqual([50, 20, null]);
  const all = [...first.items, ...second.items, ...third.items];
  expect(new Set(all.map((r) => r.runId)).size).toBe(120);
  expect(all.map((r) => r.createdOn.getTime())).toEqual([...all.map((r) => r.createdOn.getTime())].sort((x, y) => y - x));
  expect((await listRuleRuns(admin, { ruleId: other.ruleId })).items.map((r) => [r.ticketNumber, r.result])).toEqual([[f.tickets.bOrg.number, 'failed']]);
  await expect(listRuleRuns(admin, { ruleId, cursor: 'x' })).rejects.toMatchObject({ code: 'invalid_input' });
});

test('списки для редактора правила: сотрудники, теги, шаблоны, модули, названия выбранных организаций', async () => {
  await tag('VIP');
  await pools.root.query(`insert into hdr_reply_templates (shortcut, title, body, is_enabled) values ('ask', 'Запрос версии', '{"ru": "Пришлите версию"}', true), ('old', 'Старый', '{"ru": "Текст"}', false)`);
  await pools.root.query(`insert into hdr_product_modules (code, name) values ('orders', '{"ru": "Заказы", "en": "Orders"}')`);
  const options = await ruleOptions(admin, { locale: 'en', orgIds: [f.orgB.orgId, ID] });
  expect(options.events).toEqual(['ticket_created', 'client_replied', 'staff_replied', 'status_changed', 'priority_changed', 'rated', 'sla_soon', 'sla_breached', 'no_activity']);
  expect(options.queues).toEqual(['l1', 'l2', 'care']);
  expect(options.statusTargets).toEqual(['in_progress', 'waiting_customer', 'in_development', 'closed']);
  expect(options.categories).toEqual(['A', 'B', 'C', 'D', 'none']);
  expect(new Set(options.staff.map((s) => `${s.name}:${s.role}`))).toEqual(new Set(['Камила:care', 'Азиз:agent_l1', 'Рустам:admin']));
  expect(options.tags.map((t) => t.name)).toEqual(['VIP']);
  expect(options.templates.map((t) => [t.shortcut, t.title, t.isEnabled])).toEqual([['ask', 'Запрос версии', true], ['old', 'Старый', false]]);
  expect(options.modules.map((m) => [m.code, m.name])).toEqual([['orders', 'Orders']]);
  expect(options.orgs).toEqual([{ orgId: f.orgB.orgId, name: 'Globex' }]);
  expect((await ruleOptions(admin)).orgs).toEqual([]);
});
