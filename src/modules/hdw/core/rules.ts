import 'server-only';
import { and, asc, desc, eq, inArray, lt, or, sql } from 'drizzle-orm';
import type { Tx } from '@/db/client';
import { type StaffActor, type SystemActor, withActor } from '@/db/with-actor';
import { writeAudit } from '@/modules/hdc/api';
import { ticketNumbersTx } from '@/modules/hdt/api/automation';
import { builtinCodesForExtraEvent, builtinRule } from '../builtin';
import { HdwError } from '../error';
import { type DisabledReason, type RuleEventKind, RUNS_KEEP_DAYS, RUNS_PAGE, type RunResult } from '../pref';
import { type Conditions, type RuleAction, type RuleDefinition, storedRule } from '../rule-schema';
import { type ActionDone, ruleRuns, rules } from '../schema';

// Модуль hdw, слой core: правила автоматизации в базе (FR-AUTO-01, 06; план M8, задача 3). Читают сотрудники и
// система, создаёт, меняет и удаляет администратор: права держат политики RLS и триггер t_hdw_rules_guard, код
// проверяет роль раньше, чтобы ответить кодом. Каждое изменение пишет запись журнала аудита в той же транзакции.

export type RuleRecord = {
  ruleId: string;
  name: string;
  event: RuleEventKind;
  hours: number | null;
  conditions: Conditions;
  actions: RuleAction[];
  /** Условия и действия в базе прошли схему. Негодное правило (схема изменилась) не применяется и ждёт правки. */
  isValid: boolean;
  orderNo: number;
  isStop: boolean;
  isEnabled: boolean;
  disabledReason: DisabledReason | null;
  /** Код предустановленного правила: его нельзя удалить. */
  pcode: string | null;
  modifiedOn: Date;
  /** Когда правило включили последний раз. Пусто: не включали или включено поставкой. */
  enabledOn: Date | null;
};

const columns = {
  ruleId: rules.ruleId,
  name: rules.name,
  event: rules.event,
  hours: rules.hours,
  conditions: rules.conditions,
  actions: rules.actions,
  orderNo: rules.orderNo,
  isStop: rules.isStop,
  isEnabled: rules.isEnabled,
  disabledReason: rules.disabledReason,
  pcode: rules.pcode,
  modifiedOn: rules.modifiedOn,
  enabledOn: rules.enabledOn,
};
const inOrder = [asc(rules.orderNo), asc(rules.ruleId)];

function toRecord(row: { conditions: unknown; actions: unknown } & Omit<RuleRecord, 'conditions' | 'actions' | 'isValid'>): RuleRecord {
  const parsed = storedRule.safeParse({ conditions: row.conditions, actions: row.actions });
  return parsed.success
    ? { ...row, conditions: parsed.data.conditions as Conditions, actions: parsed.data.actions, isValid: true }
    : { ...row, conditions: { match: 'all', items: [] }, actions: [], isValid: false };
}

function requireAdmin(actor: StaffActor): void {
  if (actor.staffRole !== 'admin') throw new HdwError('forbidden');
}

/** Все правила по порядку применения. */
export async function listRulesTx(actor: StaffActor): Promise<RuleRecord[]> {
  const rows = await withActor(actor, (tx) => tx.select(columns).from(rules).orderBy(...inOrder));
  return rows.map(toRecord);
}

export async function readRuleTx(actor: StaffActor, ruleId: string): Promise<RuleRecord | null> {
  const [row] = await withActor(actor, (tx) => tx.select(columns).from(rules).where(eq(rules.ruleId, ruleId)).limit(1));
  return row ? toRecord(row) : null;
}

/**
 * Включённые правила события по порядку: в транзакции разбора события. Вместе с правилами самого события идут
 * предустановленные правила, которые срабатывают на него сверх своего (сообщение дежурным о P1 при смене приоритета).
 */
export async function enabledRulesTx(tx: Tx, event: RuleEventKind): Promise<RuleRecord[]> {
  const extra = builtinCodesForExtraEvent(event);
  const matches = extra.length > 0 ? or(eq(rules.event, event), inArray(rules.pcode, extra)) : eq(rules.event, event);
  const rows = await tx.select(columns).from(rules).where(and(matches, eq(rules.isEnabled, true))).orderBy(...inOrder);
  return rows.map(toRecord);
}

/**
 * Включено ли правило сейчас и с какого момента: перед применением к обращению по событию "нет активности".
 * Читается заново под блокировкой обращения: правило могли выключить и включить, пока шёл просмотр.
 */
export async function ruleGateTx(tx: Tx, ruleId: string): Promise<{ isEnabled: boolean; enabledOn: Date | null }> {
  const [row] = await tx.select({ isEnabled: rules.isEnabled, enabledOn: rules.enabledOn }).from(rules).where(eq(rules.ruleId, ruleId)).limit(1);
  return { isEnabled: row?.isEnabled === true, enabledOn: row?.enabledOn ?? null };
}

/** Что записать в журнал о правиле: без текста заметок и слов условий, только виды. */
const summary = (rule: RuleDefinition) => ({
  name: rule.name,
  event: rule.event,
  hours: rule.hours,
  match: rule.conditions.match,
  conditions: rule.conditions.items.map((item) => item.field),
  actions: rule.actions.map((item) => item.action),
  isStop: rule.isStop,
});

/** Код предустановленного правила по идентификатору. Правило обычное: null. Нет правила: undefined. */
export async function rulePcodeTx(actor: StaffActor, ruleId: string): Promise<string | null | undefined> {
  const [row] = await withActor(actor, (tx) => tx.select({ pcode: rules.pcode }).from(rules).where(eq(rules.ruleId, ruleId)).limit(1));
  return row ? row.pcode : undefined;
}

/**
 * Вернуть предустановленному правилу поставочный вид (решение 2 плана M8): название, условия, действия и флаг
 * "остановить". Включение, порядок и журнал срабатываний не меняются. Обычное правило: not_builtin. Нет правила:
 * not_found.
 */
export async function restoreBuiltinRuleTx(actor: StaffActor, ruleId: string): Promise<void> {
  requireAdmin(actor);
  await withActor(actor, async (tx) => {
    const [before] = await tx.select({ name: rules.name, pcode: rules.pcode }).from(rules).where(eq(rules.ruleId, ruleId)).limit(1).for('update');
    if (!before) throw new HdwError('not_found');
    const shipped = builtinRule(before.pcode);
    if (!shipped) throw new HdwError('not_builtin');
    await tx.update(rules).set({ name: shipped.name, hours: null, conditions: shipped.conditions, actions: shipped.actions, isStop: shipped.isStop }).where(eq(rules.ruleId, ruleId));
    await writeAudit(tx, {
      action: 'rule.restored',
      objectType: 'rule',
      objectId: ruleId,
      diff: { pcode: before.pcode, was: before.name, name: shipped.name, conditions: shipped.conditions.items.map((item) => item.field), actions: shipped.actions.map((item) => item.action) },
    });
  });
}

/** Новое правило (выключено, последним по порядку) или правка существующего. Нет правила: not_found. */
export async function saveRuleTx(actor: StaffActor, rule: RuleDefinition): Promise<{ ruleId: string }> {
  requireAdmin(actor);
  return withActor(actor, async (tx) => {
    const values = { name: rule.name, event: rule.event, hours: rule.hours, conditions: rule.conditions, actions: rule.actions, isStop: rule.isStop };
    if (rule.ruleId) {
      const [saved] = await tx.update(rules).set(values).where(eq(rules.ruleId, rule.ruleId)).returning({ ruleId: rules.ruleId });
      if (!saved) throw new HdwError('not_found');
      await writeAudit(tx, { action: 'rule.updated', objectType: 'rule', objectId: saved.ruleId, diff: summary(rule) });
      return saved;
    }
    // Порядок новых правил считается под блокировкой: два администратора не получат один номер.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('hdw.rules_order'))`);
    const [last] = await tx.select({ orderNo: sql<number>`coalesce(max(${rules.orderNo}), 0)::int` }).from(rules);
    const [created] = await tx
      .insert(rules)
      .values({ ...values, orderNo: (last?.orderNo ?? 0) + 1, isEnabled: false })
      .returning({ ruleId: rules.ruleId });
    if (!created) throw new Error('hdw: правило не сохранено');
    await writeAudit(tx, { action: 'rule.created', objectType: 'rule', objectId: created.ruleId, diff: summary(rule) });
    return created;
  });
}

/** Включить или выключить. Включение снимает причину, по которой правило выключила система, и ставит момент включения. Нет правила: not_found. */
export async function setRuleEnabledTx(actor: StaffActor, ruleId: string, enabled: boolean): Promise<void> {
  requireAdmin(actor);
  await withActor(actor, async (tx) => {
    const [before] = await tx.select({ name: rules.name, isEnabled: rules.isEnabled, disabledReason: rules.disabledReason }).from(rules).where(eq(rules.ruleId, ruleId)).limit(1).for('update');
    if (!before) throw new HdwError('not_found');
    if (before.isEnabled === enabled && before.disabledReason === null) return;
    // Момент включения ставится при каждом включении и хранится при выключении: от него считается граница
    // события "нет активности" (накопившееся до включения молчание не срабатывает).
    await tx
      .update(rules)
      .set({ isEnabled: enabled, disabledReason: null, ...(enabled ? { enabledOn: sql`now()` } : {}) })
      .where(eq(rules.ruleId, ruleId));
    await writeAudit(tx, { action: enabled ? 'rule.enabled' : 'rule.disabled', objectType: 'rule', objectId: ruleId, diff: { name: before.name } });
  });
}

/** Сдвинуть правило на одно место вверх или вниз. Порядок всех правил перенумеровывается подряд. Край списка: ничего. */
export async function moveRuleTx(actor: StaffActor, ruleId: string, direction: 'up' | 'down'): Promise<void> {
  requireAdmin(actor);
  await withActor(actor, async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('hdw.rules_order'))`);
    const list = await tx.select({ ruleId: rules.ruleId, name: rules.name, orderNo: rules.orderNo }).from(rules).orderBy(...inOrder).for('update');
    const index = list.findIndex((row) => row.ruleId === ruleId);
    const moved = list[index];
    if (!moved) throw new HdwError('not_found');
    const target = direction === 'up' ? index - 1 : index + 1;
    const other = list[target];
    if (!other) return;
    list[index] = other;
    list[target] = moved;
    for (const [position, row] of list.entries())
      if (row.orderNo !== position + 1) await tx.update(rules).set({ orderNo: position + 1 }).where(eq(rules.ruleId, row.ruleId));
    await writeAudit(tx, { action: 'rule.moved', objectType: 'rule', objectId: ruleId, diff: { name: moved.name, direction, position: target + 1 } });
  });
}

/** Удалить правило вместе с журналом его срабатываний. Предустановленное: builtin_rule. Нет правила: not_found. */
export async function deleteRuleTx(actor: StaffActor, ruleId: string): Promise<void> {
  requireAdmin(actor);
  await withActor(actor, async (tx) => {
    const [before] = await tx.select({ name: rules.name, pcode: rules.pcode }).from(rules).where(eq(rules.ruleId, ruleId)).limit(1).for('update');
    if (!before) throw new HdwError('not_found');
    if (before.pcode !== null) throw new HdwError('builtin_rule');
    await tx.delete(rules).where(eq(rules.ruleId, ruleId));
    await writeAudit(tx, { action: 'rule.deleted', objectType: 'rule', objectId: ruleId, diff: { name: before.name } });
  });
}

export type RuleRunRecord = {
  runId: string;
  ticketNumber: number | null;
  result: RunResult;
  actions: ActionDone[];
  /** Событие hdc_domain_events. Пусто: событие "нет активности". */
  eventId: string | null;
  createdOn: Date;
};

/** Страница журнала срабатываний правила, новые сверху. cursor: идентификатор последней показанной строки. */
export async function listRuleRunsTx(actor: StaffActor, ruleId: string, cursor: string | null): Promise<{ items: RuleRunRecord[]; nextCursor: string | null }> {
  return withActor(actor, async (tx) => {
    // По индексу hdw_rule_runs_i1 (правило, время). Ключ страницы: время и идентификатор последней показанной строки.
    const after = cursor
      ? sql`(${ruleRuns.createdOn}, ${ruleRuns.runId}) < (select c.created_on, c.run_id from hdw_rule_runs c where c.run_id = ${cursor}::uuid and c.rule_id = ${ruleId}::uuid)`
      : undefined;
    const rows = await tx
      .select({ runId: ruleRuns.runId, ticketId: ruleRuns.ticketId, result: ruleRuns.result, actions: ruleRuns.actionsDone, eventId: ruleRuns.eventId, createdOn: ruleRuns.createdOn })
      .from(ruleRuns)
      .where(and(eq(ruleRuns.ruleId, ruleId), after))
      .orderBy(desc(ruleRuns.createdOn), desc(ruleRuns.runId))
      .limit(RUNS_PAGE + 1);
    const page = rows.slice(0, RUNS_PAGE);
    const numbers = await ticketNumbersTx(tx, page.map((row) => row.ticketId));
    return {
      items: page.map((row) => ({ runId: row.runId, ticketNumber: numbers.get(row.ticketId) ?? null, result: row.result, actions: row.actions, eventId: row.eventId, createdOn: row.createdOn })),
      nextCursor: rows.length > RUNS_PAGE ? (page.at(-1)?.runId ?? null) : null,
    };
  });
}

/** Ночная очистка: срабатывания старше срока хранения. */
export async function cleanupRuleRunsTx(actor: SystemActor, now: Date): Promise<number> {
  const before = new Date(now.getTime() - RUNS_KEEP_DAYS * 86_400_000);
  const rows = await withActor(actor, (tx) => tx.delete(ruleRuns).where(lt(ruleRuns.createdOn, before)).returning({ runId: ruleRuns.runId }));
  return rows.length;
}
