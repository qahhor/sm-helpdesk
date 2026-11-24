import { beforeEach, expect, test } from 'vitest';
import { withActor } from '@/db/with-actor';
import { ruleTicketFactsTx } from '@/modules/hdt/api/automation';
import { BUILTIN_RULES } from '@/modules/hdw/api';
import { runNoActivityRules } from '@/modules/hdw/api/engine';
import { saveRule, setRuleEnabled } from '@/modules/hdw/api/rules';
import { staffCtx } from './helpers/auth';
import { seedBuiltinRules } from './helpers/automation';
import { pools } from './helpers/db';
import { type Fixture, seedTwoOrgs } from './isolation/fixture';

// Исправления по независимой проверке вехи M8: правила события "нет активности" (находки I1, I2, I5).

const SYSTEM = { type: 'system', job: 'automation.process' } as const;
const HOUR = 3_600_000;
let f: Fixture;
let admin: ReturnType<typeof staffCtx>;

beforeEach(async () => {
  f = await seedTwoOrgs();
  admin = staffCtx(f.adminStaff);
});

const later = (hours: number) => new Date(Date.now() + hours * HOUR);
const runs = (ruleId: string) => pools.root.query(`select ticket_id, result from hdw_rule_runs where rule_id = $1 order by run_id`, [ruleId]).then((r) => r.rows);
const enabledOn = (ruleId: string) => pools.root.query(`select enabled_on from hdw_rules where rule_id = $1`, [ruleId]).then((r) => r.rows[0].enabled_on as Date | null);
const note = [{ action: 'add_note', text: 'Молчание' }];
const all = (items: unknown[] = []) => ({ match: 'all', items });
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
/** Правило включили давно: момент включения сдвинут в прошлое. */
const enabledLongAgo = (ruleId: string, hours: number) => pools.root.query(`update hdw_rules set enabled_on = now() - make_interval(hours => $2) where rule_id = $1`, [ruleId, hours]);

// --- I1: правка включённого правила "нет активности" не срабатывает на накопившемся молчании ---

test('I1: у включённого правила уменьшили срок молчания: обращения, которые уже молчали дольше, не срабатывают', async () => {
  // Все пять обращений набора молчат пять часов. Правило на 100 часов включено десять часов назад.
  for (const t of Object.values(f.tickets)) await age(t.ticketId, 5);
  const definition = { name: 'Молчание', event: 'no_activity', hours: 100, conditions: all(), actions: note, isStop: false };
  const { ruleId } = await saveRule(admin, definition);
  await setRuleEnabled(admin, { ruleId, enabled: true });
  await enabledLongAgo(ruleId, 10);
  const before = (await enabledOn(ruleId)) as Date;
  // Администратор меняет срок на два часа: без новой границы сработали бы все пять обращений разом.
  await saveRule(admin, { ...definition, ruleId, hours: 2 });
  const after = (await enabledOn(ruleId)) as Date;
  expect(after.getTime()).toBeGreaterThan(before.getTime() + 9 * HOUR);
  expect(await runNoActivityRules(SYSTEM, { now: new Date() })).toMatchObject({ applied: 0 });
  expect(await runs(ruleId)).toEqual([]);
  // Обращение, которое перейдёт порог после правки, сработает: граница считается от момента правки.
  await pools.root.query(`insert into hdt_ticket_messages (org_id, ticket_id, author_id, author_type, body, is_internal) values ($1, $2, $3, 'client', 'Есть новости?', false)`, [f.orgA.orgId, f.tickets.aOrg.ticketId, f.aUser.userId]);
  expect(await runNoActivityRules(SYSTEM, { now: later(3) })).toMatchObject({ applied: 1 });
  expect((await runs(ruleId)).map((run) => run.ticket_id)).toEqual([f.tickets.aOrg.ticketId]);
});

test('I1: смена условий и перевод правила на событие "нет активности" тоже ставят границу; название, действия и выключенное правило её не трогают', async () => {
  for (const t of Object.values(f.tickets)) await age(t.ticketId, 5);
  const definition = { name: 'Молчание', event: 'no_activity', hours: 2, conditions: all([{ field: 'priority', op: 'is', values: ['p1'] }]), actions: note, isStop: false };
  const { ruleId } = await saveRule(admin, definition);
  await setRuleEnabled(admin, { ruleId, enabled: true });
  await enabledLongAgo(ruleId, 10);
  const old = (await enabledOn(ruleId)) as Date;
  // Название, действия и флаг "остановить": граница прежняя.
  await saveRule(admin, { ...definition, ruleId, name: 'Молчание два часа', actions: [{ action: 'add_note', text: 'Другой текст' }], isStop: true });
  expect(await enabledOn(ruleId)).toEqual(old);
  // Условия стали шире (теперь подходят все обращения): граница новая, накопившееся молчание не срабатывает.
  await saveRule(admin, { ...definition, ruleId, conditions: all() });
  expect(((await enabledOn(ruleId)) as Date).getTime()).toBeGreaterThan(old.getTime() + 9 * HOUR);
  expect(await runNoActivityRules(SYSTEM, { now: new Date() })).toMatchObject({ applied: 0 });

  // Правило другого события, включённое давно, переводят на "нет активности".
  const other = await saveRule(admin, { name: 'На ответ клиента', event: 'client_replied', conditions: all(), actions: note, isStop: false });
  await setRuleEnabled(admin, { ruleId: other.ruleId, enabled: true });
  await enabledLongAgo(other.ruleId, 10);
  await saveRule(admin, { ruleId: other.ruleId, name: 'Теперь молчание', event: 'no_activity', hours: 2, conditions: all(), actions: note, isStop: false });
  expect(((await enabledOn(other.ruleId)) as Date).getTime()).toBeGreaterThan(Date.now() - HOUR);
  expect(await runNoActivityRules(SYSTEM, { now: new Date() })).toMatchObject({ applied: 0 });

  // Выключенное правило: правка границу не ставит, её поставит включение.
  const off = await saveRule(admin, { name: 'Выключено', event: 'no_activity', hours: 50, conditions: all(), actions: note, isStop: false });
  await saveRule(admin, { ruleId: off.ruleId, name: 'Выключено', event: 'no_activity', hours: 2, conditions: all(), actions: note, isStop: false });
  expect(await enabledOn(off.ruleId)).toBeNull();
});

test('I1: предустановленное правило без момента включения хранит пустую границу, пока не изменены условия', async () => {
  await seedBuiltinRules();
  const shipped = BUILTIN_RULES.p1_oncall;
  const ruleId = (await pools.root.query(`select rule_id from hdw_rules where pcode = 'p1_oncall'`)).rows[0].rule_id as string;
  await saveRule(admin, { ruleId, name: 'P1: дежурным', event: shipped.event, conditions: shipped.conditions, actions: [...shipped.actions, { action: 'add_note', text: 'P1' }], isStop: false });
  expect(await enabledOn(ruleId)).toBeNull();
  await saveRule(admin, { ruleId, name: 'P1: дежурным', event: shipped.event, conditions: all([...shipped.conditions.items, { field: 'source', op: 'is', values: ['portal'] }]), actions: shipped.actions, isStop: false });
  expect(await enabledOn(ruleId)).toBeInstanceOf(Date);
});

// --- I2: статусы условия сужают просмотр, только когда должны выполняться все условия ---

test('I2: правило "любое из условий" со статусом среди них просматривает открытые обращения в остальных статусах', async () => {
  // Одно обращение ждёт клиента, остальные новые. Условия: статус "ждёт клиента" ИЛИ приоритет P2 (у всех P2).
  await pools.root.query(`update hdt_tickets set status = 'waiting_customer' where ticket_id = $1`, [f.tickets.aOrg.ticketId]);
  const { ruleId } = await saveRule(admin, {
    name: 'Ждёт или P2',
    event: 'no_activity',
    hours: 1,
    conditions: { match: 'any', items: [{ field: 'status', op: 'is', values: ['waiting_customer'] }, { field: 'priority', op: 'is', values: ['p2'] }] },
    actions: note,
    isStop: false,
  });
  await setRuleEnabled(admin, { ruleId, enabled: true });
  expect(await runNoActivityRules(SYSTEM, { now: later(2) })).toMatchObject({ applied: 5 });
  expect(new Set((await runs(ruleId)).map((run) => run.ticket_id))).toEqual(new Set(Object.values(f.tickets).map((t) => t.ticketId)));
  // При "все условия" названный статус по-прежнему сужает просмотр: срабатывает только обращение в этом статусе.
  const strict = await saveRule(admin, { name: 'Ждёт и P2', event: 'no_activity', hours: 1, conditions: all([{ field: 'status', op: 'is', values: ['waiting_customer'] }, { field: 'priority', op: 'is', values: ['p2'] }]), actions: note, isStop: false });
  await setRuleEnabled(admin, { ruleId: strict.ruleId, enabled: true });
  await runNoActivityRules(SYSTEM, { now: later(2) });
  expect((await runs(strict.ruleId)).map((run) => run.ticket_id)).toEqual([f.tickets.aOrg.ticketId]);
});

// --- I5: просмотр молчащих обращений ограничен по времени и уступает разбору событий ---

test('I5: бюджет времени останавливает просмотр между пачками; следующий запуск продолжает с того же места', async () => {
  const { ruleId } = await saveRule(admin, { name: 'Молчание', event: 'no_activity', hours: 1, conditions: all(), actions: note, isStop: false });
  await setRuleEnabled(admin, { ruleId, enabled: true });
  const now = later(2);
  // Часы просмотра подменены: бюджет кончается после первой пачки из двух обращений.
  let ticks = 0;
  const first = await runNoActivityRules(SYSTEM, { now, batch: 2, budgetMs: 100, clock: () => (ticks++ < 2 ? 0 : 1000) });
  expect(first).toMatchObject({ checked: 2, applied: 2 });
  // Без бюджета: оставшиеся три обращения, с места остановки, без повторов.
  expect(await runNoActivityRules(SYSTEM, { now, batch: 2 })).toMatchObject({ checked: 3, applied: 3 });
  const done = await runs(ruleId);
  expect(done).toHaveLength(5);
  expect(new Set(done.map((run) => run.ticket_id)).size).toBe(5);
});

test('I5: бюджет общий на все правила запуска: когда он исчерпан, следующее правило ждёт следующей минуты', async () => {
  const ids: string[] = [];
  for (const name of ['Первое', 'Второе']) {
    const { ruleId } = await saveRule(admin, { name, event: 'no_activity', hours: 1, conditions: all(), actions: note, isStop: false });
    await setRuleEnabled(admin, { ruleId, enabled: true });
    ids.push(ruleId);
  }
  let ticks = 0;
  await runNoActivityRules(SYSTEM, { now: later(2), budgetMs: 100, clock: () => (ticks++ < 2 ? 0 : 1000) });
  expect(await runs(ids[0] as string)).toHaveLength(5);
  expect(await runs(ids[1] as string)).toEqual([]);
  await runNoActivityRules(SYSTEM, { now: later(2) });
  expect(await runs(ids[1] as string)).toHaveLength(5);
});

test('I5: перед каждой пачкой просмотр уступает разбору событий', async () => {
  const { ruleId } = await saveRule(admin, { name: 'Молчание', event: 'no_activity', hours: 1, conditions: all(), actions: note, isStop: false });
  await setRuleEnabled(admin, { ruleId, enabled: true });
  const seen: number[] = [];
  await runNoActivityRules(SYSTEM, {
    now: later(2),
    batch: 2,
    between: async () => {
      // Сколько срабатываний уже записано к моменту, когда просмотр уступил: 0 перед первой пачкой, 2 перед второй, 4 перед третьей.
      seen.push((await runs(ruleId)).length);
    },
  });
  expect(seen).toEqual([0, 2, 4]);
});

test('I5: тему и описание просмотр читает, только когда они нужны условию правила', async () => {
  const t = f.tickets.aOrg;
  const facts = await withActor(SYSTEM, async (tx) => ({ full: await ruleTicketFactsTx(tx, [t.ticketId]), brief: await ruleTicketFactsTx(tx, [t.ticketId], { withText: false }) }));
  expect(facts.full.get(t.ticketId)).toMatchObject({ title: t.title, description: `${t.title}: подробное описание` });
  expect(facts.brief.get(t.ticketId)).toMatchObject({ number: t.number, title: '', description: '' });
  // Правило с условием по тексту читает текст и срабатывает только на подходящем обращении.
  const { ruleId } = await saveRule(admin, { name: 'По тексту', event: 'no_activity', hours: 1, conditions: all([{ field: 'text', op: 'contains_any', words: ['Отчёт А'] }]), actions: note, isStop: false });
  await setRuleEnabled(admin, { ruleId, enabled: true });
  expect(await runNoActivityRules(SYSTEM, { now: later(2) })).toMatchObject({ applied: 1 });
  expect((await runs(ruleId)).map((run) => run.ticket_id)).toEqual([t.ticketId]);
});
