import 'server-only';
import * as z from 'zod';
import { withActor } from '@/db/with-actor';
import { FRESH_SIGN_IN_SEC, isFresh, type StaffContext } from '@/modules/hdc/api';
import { listActiveModules, listAllTemplates, listTags, type ModuleOption, type Tag, tagsByIdTx, templatesByIdTx } from '@/modules/hdr/api';
import { IMPACTS, PRIORITIES, QUEUES, TICKET_SOURCES, TICKET_STATUSES, TICKET_TYPES } from '@/modules/hdt/pref';
import { orgFactsTx, type StaffMember, staffRoster } from '@/modules/hdu/api/automation';
import { type DryRunResult, dryRunTx } from '../core/dry-run';
import { deleteRuleTx, listRuleRunsTx, listRulesTx, moveRuleTx, readRuleTx, type RuleRecord, type RuleRunRecord, saveRuleTx, setRuleEnabledTx } from '../core/rules';
import { HdwError } from '../error';
import { NOTIFY_ROLES, ORG_CATEGORIES, RULE_EVENTS, RULE_STATUS_TARGETS } from '../pref';
import { parseRule, type RuleDefinition, type RuleIssue } from '../rule-schema';

// Модуль hdw, слой api: правила автоматизации для экрана администратора (FR-AUTO-01, 06, 08, FR-ADM-10; план M8,
// задачи 3 и 4). Сотрудник из проверенной сессии, вход по схеме. Читает и меняет правила только администратор;
// изменение требует входа не старше 15 минут, как остальные настройки (ТЗ 14.3). Каждое изменение и каждый пробный
// прогон пишут запись журнала аудита в той же транзакции.

export type { DryRunMatch, DryRunResult } from '../core/dry-run';
export type { RuleRecord, RuleRunRecord } from '../core/rules';
export { HdwError, type HdwErrorCode, isHdwError } from '../error';
export type { Condition, Conditions, NotifyTarget, RuleAction, RuleActionKind, RuleDefinition, RuleIssue, RuleIssueCode } from '../rule-schema';
export type { ActionDone } from '../schema';
export { DRY_RUN_TICKETS, LOOP_LIMIT, MAX_ACTIONS, MAX_CONDITIONS, MAX_HOURS, MAX_SNOOZE_HOURS, RULE_EVENTS, RULE_NAME_MAX, RULE_NOTE_MAX, RUNS_PAGE, type RuleEvent, type RunResult } from '../pref';

function requireAdmin(ctx: StaffContext): void {
  if (ctx.actor.staffRole !== 'admin') throw new HdwError('forbidden');
}

/** Изменение правил: администратор со входом не старше 15 минут (ТЗ 14.3, решение 0014). */
function requireFreshAdmin(ctx: StaffContext): void {
  requireAdmin(ctx);
  if (!isFresh(ctx, new Date(), FRESH_SIGN_IN_SEC)) throw new HdwError('stale_session');
}

function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const parsed = schema.safeParse(input);
  if (!parsed.success) throw new HdwError('invalid_input');
  return parsed.data;
}

const idInput = z.strictObject({ ruleId: z.uuid() });
const enabledInput = z.strictObject({ ruleId: z.uuid(), enabled: z.boolean() });
const moveInput = z.strictObject({ ruleId: z.uuid(), direction: z.enum(['up', 'down']) });
const runsInput = z.strictObject({ ruleId: z.uuid(), cursor: z.uuid().nullable().optional() });
const optionsInput = z.strictObject({ locale: z.enum(['ru', 'uz', 'en']).default('ru'), orgIds: z.array(z.uuid()).max(200).default([]) });

function definitionOf(input: unknown): RuleDefinition {
  const parsed = parseRule(input);
  if (!parsed.ok) throw new HdwError('invalid_input', parsed.issues);
  return parsed.rule;
}

const WRITER_ROLES: readonly string[] = ['agent_l1', 'agent_l2', 'care', 'admin'];

/**
 * Ссылки правила, которых нет в справочниках: модули, организации, теги, шаблоны, сотрудники. Очереди, статусы и
 * роли проверяет схема. Адрес вебхука не проверяется: список адресов появится в задаче 5 вехи, до неё действие
 * записывается невыполненным.
 */
async function missingReferences(ctx: StaffContext, rule: RuleDefinition): Promise<RuleIssue[]> {
  const issues: RuleIssue[] = [];
  const missing = (path: string) => issues.push({ path, code: 'reference_missing' });
  const conditionIds = (field: 'module' | 'org' | 'tags') => {
    const refs: { index: number; value: string }[] = [];
    for (const [index, item] of rule.conditions.items.entries())
      if (item.field === field) for (const value of item.values) if (value !== null) refs.push({ index, value });
    return refs;
  };
  const moduleRefs = conditionIds('module');
  const orgRefs = conditionIds('org');
  const tagRefs = conditionIds('tags');
  const tagActions = rule.actions.flatMap((item, index) => (item.action === 'add_tag' || item.action === 'remove_tag' ? [{ index, value: item.tagId }] : []));
  const templateActions = rule.actions.flatMap((item, index) => (item.action === 'reply_template' ? [{ index, value: item.templateId }] : []));

  if (moduleRefs.length > 0) {
    const modules = new Set((await listActiveModules(ctx.actor, 'ru')).map((item) => item.moduleId));
    for (const ref of moduleRefs) if (!modules.has(ref.value)) missing(`conditions.items.${ref.index}.values`);
  }
  if (orgRefs.length + tagRefs.length + tagActions.length + templateActions.length > 0) {
    const found = await withActor(ctx.actor, async (tx) => ({
      orgs: await orgFactsTx(tx, orgRefs.map((ref) => ref.value)),
      tags: await tagsByIdTx(tx, [...tagRefs, ...tagActions].map((ref) => ref.value)),
      templates: await templatesByIdTx(tx, templateActions.map((ref) => ref.value)),
    }));
    for (const ref of orgRefs) if (!found.orgs.has(ref.value)) missing(`conditions.items.${ref.index}.values`);
    for (const ref of tagRefs) if (!found.tags.has(ref.value)) missing(`conditions.items.${ref.index}.values`);
    for (const ref of tagActions) if (!found.tags.has(ref.value)) missing(`actions.${ref.index}.tagId`);
    for (const ref of templateActions) if (!found.templates.has(ref.value)) missing(`actions.${ref.index}.templateId`);
  }
  if (rule.actions.some((item) => item.action === 'assign' || (item.action === 'notify' && item.target.kind === 'user'))) {
    const roster = await staffRoster();
    for (const [index, item] of rule.actions.entries()) {
      // Исполнителем становится только сотрудник, который ведёт обращения; уведомить можно любого действующего.
      if (item.action === 'assign' && !roster.some((member) => member.userId === item.userId && WRITER_ROLES.includes(member.role))) missing(`actions.${index}.userId`);
      if (item.action === 'notify' && item.target.kind === 'user') {
        const userId = item.target.userId;
        if (!roster.some((member) => member.userId === userId)) missing(`actions.${index}.target.userId`);
      }
    }
  }
  // Один путь называется один раз, даже если в списке значений не найдено несколько.
  return issues.filter((issue, index) => issues.findIndex((other) => other.path === issue.path) === index);
}

/** Все правила по порядку применения. Только администратор. */
export async function listRules(ctx: StaffContext): Promise<RuleRecord[]> {
  requireAdmin(ctx);
  return listRulesTx(ctx.actor);
}

/** Правило по идентификатору. Нет такого или идентификатор негоден: null. */
export async function readRule(ctx: StaffContext, ruleId: unknown): Promise<RuleRecord | null> {
  requireAdmin(ctx);
  const id = z.uuid().safeParse(ruleId);
  return id.success ? readRuleTx(ctx.actor, id.data) : null;
}

/**
 * Создать правило (без ruleId: выключено, последним по порядку) или изменить существующее. Отказ invalid_input несёт
 * issues: путь до поля и код (в том числе reference_missing для удалённого тега, шаблона, сотрудника, модуля,
 * организации). Включение правила при правке не меняется.
 */
export async function saveRule(ctx: StaffContext, input: unknown): Promise<{ ruleId: string }> {
  requireFreshAdmin(ctx);
  const rule = definitionOf(input);
  const issues = await missingReferences(ctx, rule);
  if (issues.length > 0) throw new HdwError('invalid_input', issues);
  return saveRuleTx(ctx.actor, rule);
}

/** Включить или выключить правило. Включение снимает отметку "выключено защитой от зацикливания". */
export async function setRuleEnabled(ctx: StaffContext, input: unknown): Promise<void> {
  requireFreshAdmin(ctx);
  const data = parse(enabledInput, input);
  await setRuleEnabledTx(ctx.actor, data.ruleId, data.enabled);
}

/** Сдвинуть правило на одно место вверх или вниз (FR-AUTO-06). На краю списка ничего не меняется. */
export async function moveRule(ctx: StaffContext, input: unknown): Promise<void> {
  requireFreshAdmin(ctx);
  const data = parse(moveInput, input);
  await moveRuleTx(ctx.actor, data.ruleId, data.direction);
}

/** Удалить правило и журнал его срабатываний. Предустановленное правило: builtin_rule. */
export async function deleteRule(ctx: StaffContext, input: unknown): Promise<void> {
  requireFreshAdmin(ctx);
  await deleteRuleTx(ctx.actor, parse(idInput, input).ruleId);
}

/** Журнал срабатываний правила, новые сверху, по 50. cursor: nextCursor предыдущей страницы. */
export async function listRuleRuns(ctx: StaffContext, input: unknown): Promise<{ items: RuleRunRecord[]; nextCursor: string | null }> {
  requireAdmin(ctx);
  const data = parse(runsInput, input);
  return listRuleRunsTx(ctx.actor, data.ruleId, data.cursor ?? null);
}

/**
 * Пробный прогон (FR-AUTO-08): на каких из последних 100 обращений условия правила выполнены сейчас и что сделали
 * бы действия. Вид события по истории обращений не проверяется. Ничего не меняет, кроме записи журнала о прогоне.
 * Правило можно прогнать до сохранения: ссылки на справочники не проверяются, отсутствующая ссылка видна в описании
 * действия.
 */
export async function dryRunRule(ctx: StaffContext, input: unknown): Promise<DryRunResult> {
  requireAdmin(ctx);
  return dryRunTx(ctx.actor, definitionOf(input), new Date());
}

export type RuleOptions = {
  events: readonly string[];
  types: readonly string[];
  priorities: readonly string[];
  impacts: readonly string[];
  statuses: readonly string[];
  /** Статусы, которые может поставить действие "сменить статус". */
  statusTargets: readonly string[];
  queues: readonly string[];
  sources: readonly string[];
  locales: readonly string[];
  categories: readonly string[];
  /** Роли для действия "уведомить роль". */
  roles: readonly string[];
  /** Действующие сотрудники. Исполнителем можно выбрать любого, кроме роли product; уведомить любого. */
  staff: StaffMember[];
  tags: Tag[];
  templates: { templateId: string; shortcut: string; title: string; isEnabled: boolean }[];
  modules: ModuleOption[];
  /** Названия организаций, запрошенных в orgIds: подписи уже выбранных в правиле организаций. */
  orgs: { orgId: string; name: string }[];
};

/** Списки для редактора правила. locale: язык названий модулей; orgIds: организации, которым нужны названия. */
export async function ruleOptions(ctx: StaffContext, input: unknown = {}): Promise<RuleOptions> {
  requireAdmin(ctx);
  const data = parse(optionsInput, input);
  const [staff, tags, templates, modules, orgs] = await Promise.all([
    staffRoster(),
    listTags(ctx),
    listAllTemplates(ctx),
    listActiveModules(ctx.actor, data.locale),
    data.orgIds.length > 0 ? withActor(ctx.actor, (tx) => orgFactsTx(tx, data.orgIds)) : Promise.resolve(new Map<string, { name: string }>()),
  ]);
  return {
    events: RULE_EVENTS,
    types: TICKET_TYPES,
    priorities: PRIORITIES,
    impacts: IMPACTS,
    statuses: TICKET_STATUSES,
    statusTargets: RULE_STATUS_TARGETS,
    queues: QUEUES,
    sources: TICKET_SOURCES,
    locales: ['ru', 'uz', 'en'],
    categories: ORG_CATEGORIES,
    roles: NOTIFY_ROLES,
    staff,
    tags,
    templates: templates.map((item) => ({ templateId: item.templateId, shortcut: item.shortcut, title: item.title, isEnabled: item.isEnabled })),
    modules,
    orgs: [...orgs].map(([orgId, org]) => ({ orgId, name: org.name })),
  };
}
