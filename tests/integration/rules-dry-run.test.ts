import { beforeEach, expect, test } from 'vitest';
import { processEvents } from '@/modules/hdc/api';
import { postStaffMessage, replyToTicket, setPriority, setStatus } from '@/modules/hdt/api';
import { handleRuleEvent, newRuleRun, runNoActivityRules } from '@/modules/hdw/api/engine';
import { dryRunRule, saveRule, setRuleEnabled } from '@/modules/hdw/api/rules';
import { clientCtx, staffCtx } from './helpers/auth';
import { pools } from './helpers/db';
import { type Fixture, seedTwoOrgs } from './isolation/fixture';

// Пробный прогон правила отбирает обращения так же, как их выбрало бы настоящее применение (FR-AUTO-08; волна 5,
// задача 2): среди последних 100 обращений только те, у которых по истории было событие вида правила, а для "нет
// активности" обращения, молчащие не меньше заданных часов, с тем же просмотром статусов, что у настоящего просмотра.
// Проверка: на подготовленном наборе число совпадений пробного прогона равно числу настоящих срабатываний того же
// правила, включённого после прогона.

const SYSTEM = { type: 'system', job: 'automation.process' } as const;
let f: Fixture;
let admin: ReturnType<typeof staffCtx>;

beforeEach(async () => {
  f = await seedTwoOrgs();
  admin = staffCtx(f.adminStaff);
});

const note = [{ action: 'add_note', text: 'Проверка пробного прогона' }];
const definition = (event: string, extra: Record<string, unknown> = {}) => ({ name: `Правило ${event}`, event, conditions: { match: 'all', items: [] }, actions: note, ...extra });
/** Номера обращений, на которых правило по-настоящему сработало (что-то сделало). */
const firedNumbers = (ruleId: string) =>
  pools.root
    .query(`select t.number from hdw_rule_runs r join hdt_tickets t on t.ticket_id = r.ticket_id where r.rule_id = $1 and r.result in ('applied', 'partial') order by t.number`, [ruleId])
    .then((r) => r.rows.map((row) => Number(row.number)));
const sorted = (list: number[]) => [...list].sort((a, b) => a - b);

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

test('событие обращения: совпадений пробного прогона столько же, сколько настоящих срабатываний', async () => {
  // История набора без событий в очереди: публичные сообщения набора будто разобраны давно. Их убираем, чтобы
  // история и очередь событий совпадали, как у обращений, созданных через приложение.
  await pools.root.query(`delete from hdt_ticket_messages where not is_internal`);
  const l1 = staffCtx(f.l1);
  const seen = () => new Date(Date.now() + 60_000).toISOString();
  await replyToTicket(await clientCtx(f.aUser), { number: f.tickets.aOrg.number, body: 'Отчёт всё ещё пустой' });
  await postStaffMessage(l1, { number: f.tickets.bOrg.number, body: 'Проверяем отчёт', internal: false, seenVersion: seen() });
  // Внутренняя заметка ответом не считается ни там, ни там.
  await postStaffMessage(l1, { number: f.tickets.aMine.number, body: 'Заметка для коллег', internal: true, seenVersion: seen() });
  await setPriority(l1, { number: f.tickets.aMine.number, priority: 'p1', reason: 'Стоит склад' });
  await setStatus(l1, { number: f.tickets.aPrivate.number, to: 'in_progress' });
  // Подтверждение приоритета без смены пишет событие истории, но не событие правил: в пробный прогон не входит.
  const kept = (await pools.root.query(`select priority from hdt_tickets where ticket_id = $1`, [f.tickets.bOrg.ticketId])).rows[0].priority;
  await setPriority(l1, { number: f.tickets.bOrg.number, priority: kept, reason: 'Приоритет подтверждён' });

  const events = ['client_replied', 'staff_replied', 'status_changed', 'priority_changed', 'rated'] as const;
  const dry = new Map<string, Awaited<ReturnType<typeof dryRunRule>>>();
  for (const event of events) dry.set(event, await dryRunRule(admin, definition(event)));
  // Набор отбора назван: событие и окно последних обращений.
  expect(dry.get('client_replied')?.basis).toEqual({ kind: 'event', event: 'client_replied', window: 100 });
  expect(dry.get('client_replied')?.matches.map((m) => m.number)).toEqual([f.tickets.aOrg.number]);
  expect(dry.get('rated')).toMatchObject({ checked: 0, count: 0 });

  const ruleIds = new Map<string, string>();
  for (const event of events) {
    const { ruleId } = await saveRule(admin, definition(event));
    await setRuleEnabled(admin, { ruleId, enabled: true });
    ruleIds.set(event, ruleId);
  }
  const run = newRuleRun();
  await processEvents(SYSTEM, (tx, event) => handleRuleEvent(tx, event, run));
  for (const event of events) {
    const fired = await firedNumbers(ruleIds.get(event) as string);
    expect(sorted(dry.get(event)?.matches.map((m) => m.number) ?? []), event).toEqual(fired);
    expect(dry.get(event)?.count, event).toBe(fired.length);
  }
});

test('нет активности: молчащие не меньше заданных часов, с просмотром статусов как у настоящего правила', async () => {
  // Решённое и закрытое правило без условия на статус не берёт; открытое, молчащее меньше порога, тоже.
  await pools.root.query(`update hdt_tickets set status = 'closed' where ticket_id = $1`, [f.tickets.aOrg.ticketId]);
  await age(f.tickets.aOrg.ticketId, 5);
  await age(f.tickets.aMine.ticketId, 5);
  await age(f.tickets.bOrg.ticketId, 4);
  await age(f.tickets.aPrivate.ticketId, 1);
  const open = definition('no_activity', { name: 'Молчат три часа', hours: 3 });
  const closed = definition('no_activity', { name: 'Закрытые молчат', hours: 3, conditions: { match: 'all', items: [{ field: 'status', op: 'is', values: ['closed'] }] } });

  const dryOpen = await dryRunRule(admin, open);
  const dryClosed = await dryRunRule(admin, closed);
  expect(dryOpen.basis).toEqual({ kind: 'silent', hours: 3, window: 100 });
  expect(sorted(dryOpen.matches.map((m) => m.number))).toEqual(sorted([f.tickets.aMine.number, f.tickets.bOrg.number]));
  expect(dryClosed.matches.map((m) => m.number)).toEqual([f.tickets.aOrg.number]);

  const ids: string[] = [];
  for (const rule of [open, closed]) {
    const { ruleId } = await saveRule(admin, rule);
    await setRuleEnabled(admin, { ruleId, enabled: true });
    ids.push(ruleId);
  }
  // Пробный прогон отвечает "что подошло бы": момент включения он не учитывает. Чтобы настоящий просмотр взял то же
  // молчание, момент включения отодвигается в прошлое.
  await pools.root.query(`update hdw_rules set enabled_on = enabled_on - interval '1 day' where rule_id = any($1)`, [ids]);
  await runNoActivityRules(SYSTEM, { now: new Date() });
  expect(await firedNumbers(ids[0] as string)).toEqual(sorted(dryOpen.matches.map((m) => m.number)));
  expect(await firedNumbers(ids[1] as string)).toEqual(dryClosed.matches.map((m) => m.number));
});

test('нарушение срока: обращения с отметкой нарушения в истории', async () => {
  await pools.root.query(
    `insert into hdt_ticket_events (org_id, ticket_id, kind, actor_type, payload, is_internal) values ($1, $2, 'due', 'system', '{"kind":"resolution"}', true)`,
    [f.orgA.orgId, f.tickets.aOrg.ticketId],
  );
  const dry = await dryRunRule(admin, definition('sla_breached'));
  expect(dry).toMatchObject({ checked: 1, count: 1, basis: { kind: 'event', event: 'sla_breached', window: 100 } });
  expect(dry.matches.map((m) => m.number)).toEqual([f.tickets.aOrg.number]);
  // Создание есть у каждого обращения: прогон берёт все последние.
  expect(await dryRunRule(admin, definition('ticket_created'))).toMatchObject({ checked: 5, count: 5 });
});
