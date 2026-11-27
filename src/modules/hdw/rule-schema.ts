import * as z from 'zod';
import { cleanUserText } from '@/modules/hdc/pref';
import { AI_HANDOFF_REASONS, IMPACTS, PRIORITIES, QUEUES, TICKET_SOURCES, TICKET_STATUSES, TICKET_TYPES } from '@/modules/hdt/pref';
import { BUILTIN_ACTIONS, type BuiltinAction, MAX_ACTIONS, MAX_CONDITIONS, MAX_HOURS, MAX_SNOOZE_HOURS, NOTIFY_ROLES, ORG_CATEGORIES, RULE_EVENT_KINDS, RULE_NAME_MAX, RULE_NOTE_MAX, RULE_STATUS_TARGETS } from './pref';

// Модуль hdw: схема правила автоматизации (FR-AUTO-01, 03, 04, 05; план M8, задача 3). Правило это данные: событие,
// условия ("все" или "любое") и действия из закрытого перечня. Формул, скриптов и регулярных выражений нет.
// Чистый файл без базы: существование очередей, людей, тегов и шаблонов проверяет слой api при сохранении.

/** Коды отказов схемы: слой api отдаёт их редактору вместе с путём до поля. */
// builtin_only: действие предустановленного правила в другом правиле; builtin_event: у предустановленного правила
// меняют событие. Обе проверки делает слой api: схема не знает, какое правило сохраняется.
export const RULE_ISSUE_CODES = ['event_not_ready', 'condition_not_ready', 'hours_required', 'hours_not_allowed', 'reference_missing', 'builtin_only', 'builtin_event', 'invalid'] as const;
export type RuleIssueCode = (typeof RULE_ISSUE_CODES)[number];
export type RuleIssue = { path: string; code: RuleIssueCode };

const listOp = z.enum(['is', 'is_not']);
const values = <T extends z.ZodType>(item: T) => z.array(item).min(1).max(20);
const listCondition = <F extends string, T extends z.ZodType>(field: F, item: T) => z.strictObject({ field: z.literal(field), op: listOp, values: values(item) });
const hours = z.number().min(0).max(MAX_HOURS);
/** Слово для условия "текст содержит": от 2 до 50 знаков, без невидимых знаков. Ищется как подстрока без учёта регистра. */
const word = z.string().overwrite(cleanUserText).trim().min(2).max(50);

const condition = z.union([
  z.discriminatedUnion('field', [
    listCondition('type', z.enum(TICKET_TYPES)),
    // null: модуль у обращения не указан.
    listCondition('module', z.uuid().nullable()),
    listCondition('priority', z.enum(PRIORITIES)),
    listCondition('impact', z.enum(IMPACTS)),
    listCondition('status', z.enum(TICKET_STATUSES)),
    listCondition('queue', z.enum(QUEUES)),
    listCondition('source', z.enum(TICKET_SOURCES)),
    listCondition('locale', z.enum(['ru', 'uz', 'en'])),
    listCondition('org_category', z.enum(ORG_CATEGORIES)),
    listCondition('org', z.uuid()),
    // Причина передачи от AI (план M5b, задача 8): перечень FR-AI-14 и уточнения no_text, language.
    listCondition('ai_reason', z.enum(AI_HANDOFF_REASONS)),
    z.strictObject({ field: z.literal('tags'), op: z.enum(['has_any', 'has_all', 'has_none']), values: values(z.uuid()) }),
    z.strictObject({ field: z.literal('text'), op: z.enum(['contains_any', 'contains_none']), words: z.array(word).min(1).max(10) }),
    z.strictObject({ field: z.literal('work_time'), op: z.literal('is'), value: z.enum(['working', 'off']) }),
    z.strictObject({ field: z.literal('hours_since_client'), op: z.enum(['gte', 'lt']), value: hours }),
    z.strictObject({ field: z.literal('hours_since_staff'), op: z.enum(['gte', 'lt']), value: hours }),
    z.strictObject({ field: z.literal('rating'), op: z.enum(['is', 'lte', 'gte']), value: z.number().int().min(1).max(5) }),
  ]),
  // Условия ТЗ, для которых ещё нет данных (веха M5c): названы, но не принимаются.
  z.looseObject({ field: z.enum(['signature', 'known_problem']) }).refine(() => false, { error: 'condition_not_ready' }),
]);
export type Condition = Exclude<z.infer<typeof condition>, { field: 'signature' | 'known_problem' }>;

const conditions = z.strictObject({ match: z.enum(['all', 'any']), items: z.array(condition).max(MAX_CONDITIONS) });
export type Conditions = { match: 'all' | 'any'; items: Condition[] };

const notifyTarget = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('user'), userId: z.uuid() }),
  z.strictObject({ kind: z.literal('role'), role: z.enum(NOTIFY_ROLES) }),
  z.strictObject({ kind: z.literal('oncall') }),
]);
export type NotifyTarget = z.infer<typeof notifyTarget>;

/**
 * Действия по одному: из них собраны действия правила и действия макроса (src/modules/hdw/macro-schema.ts). Макрос
 * берёт тот же набор без вебхука, распределения по кругу и уведомления (UX-A-16).
 */
export const actionSchemas = {
  set_queue: z.strictObject({ action: z.literal('set_queue'), queue: z.enum(QUEUES) }),
  assign: z.strictObject({ action: z.literal('assign'), userId: z.uuid() }),
  assign_round_robin: z.strictObject({ action: z.literal('assign_round_robin') }),
  set_priority: z.strictObject({ action: z.literal('set_priority'), priority: z.enum(PRIORITIES) }),
  add_tag: z.strictObject({ action: z.literal('add_tag'), tagId: z.uuid() }),
  remove_tag: z.strictObject({ action: z.literal('remove_tag'), tagId: z.uuid() }),
  add_note: z.strictObject({ action: z.literal('add_note'), text: z.string().overwrite(cleanUserText).trim().min(1).max(RULE_NOTE_MAX) }),
  reply_template: z.strictObject({ action: z.literal('reply_template'), templateId: z.uuid() }),
  notify: z.strictObject({ action: z.literal('notify'), target: notifyTarget }),
  snooze: z.strictObject({ action: z.literal('snooze'), hours: z.number().int().min(1).max(MAX_SNOOZE_HOURS) }),
  set_status: z.strictObject({ action: z.literal('set_status'), status: z.enum(RULE_STATUS_TARGETS) }),
  webhook: z.strictObject({ action: z.literal('webhook'), endpointId: z.uuid() }),
  // Действия только предустановленных правил (FR-AUTO-12; план M8, задача 10): прежние встроенные уведомления с их
  // получателями и шаблонами. Значения у них нет. В каком правиле действие допустимо, проверяет слой api.
  notify_oncall_p1: z.strictObject({ action: z.literal('notify_oncall_p1') }),
  notify_sla_breach: z.strictObject({ action: z.literal('notify_sla_breach') }),
  notify_csat_low: z.strictObject({ action: z.literal('notify_csat_low') }),
};

const action = z.discriminatedUnion('action', [
  actionSchemas.set_queue,
  actionSchemas.assign,
  actionSchemas.assign_round_robin,
  actionSchemas.set_priority,
  actionSchemas.add_tag,
  actionSchemas.remove_tag,
  actionSchemas.add_note,
  actionSchemas.reply_template,
  actionSchemas.notify,
  actionSchemas.snooze,
  actionSchemas.set_status,
  actionSchemas.webhook,
  actionSchemas.notify_oncall_p1,
  actionSchemas.notify_sla_breach,
  actionSchemas.notify_csat_low,
]);
export type RuleAction = z.infer<typeof action>;
export type RuleActionKind = RuleAction['action'];

const actions = z.array(action).min(1).max(MAX_ACTIONS);

const BUILTIN_ACTION_SET: ReadonlySet<string> = new Set(BUILTIN_ACTIONS);
/** Действие только предустановленного правила. */
export const isBuiltinAction = (item: { action: string }): item is { action: BuiltinAction } => BUILTIN_ACTION_SET.has(item.action);

/** Условия и действия сохранённого правила: той же схемой читает их применение, негодное правило не выполняется. */
export const storedRule = z.object({ conditions, actions });

export const ruleInput = z
  .strictObject({
    ruleId: z.uuid().optional(),
    name: z.string().overwrite(cleanUserText).trim().min(1).max(RULE_NAME_MAX),
    event: z.enum(RULE_EVENT_KINDS),
    /** Только для события "нет активности": через сколько часов молчания срабатывает правило. */
    hours: z.number().int().min(1).max(MAX_HOURS).nullable().optional(),
    conditions,
    actions,
    isStop: z.boolean().default(false),
  })
  .superRefine((rule, ctx) => {
    const has = rule.hours !== null && rule.hours !== undefined;
    if (rule.event === 'no_activity' && !has) ctx.addIssue({ code: 'custom', path: ['hours'], message: 'hours_required' });
    if (rule.event !== 'no_activity' && has) ctx.addIssue({ code: 'custom', path: ['hours'], message: 'hours_not_allowed' });
  });

export type RuleDefinition = {
  ruleId?: string;
  name: string;
  event: (typeof RULE_EVENT_KINDS)[number];
  hours: number | null;
  conditions: Conditions;
  actions: RuleAction[];
  isStop: boolean;
};

const CODES: ReadonlySet<string> = new Set(RULE_ISSUE_CODES);

/** Отказы схемы с путём до поля и кодом: общий разбор для правила и макроса. */
export function issuesOf(error: z.ZodError): RuleIssue[] {
  const issues: RuleIssue[] = [];
  const walk = (list: readonly z.core.$ZodIssue[], prefix: PropertyKey[]) => {
    for (const issue of list) {
      const path = [...prefix, ...issue.path];
      // Отказ объединения несёт отказы вариантов: из них берётся названный код ("условие пока не поддержано").
      if (issue.code === 'invalid_union') {
        const before = issues.length;
        for (const branch of issue.errors) walk(branch.filter((inner) => CODES.has(inner.message)), path);
        if (issues.length > before) continue;
      }
      issues.push({ path: path.map(String).join('.'), code: CODES.has(issue.message) ? (issue.message as RuleIssueCode) : 'invalid' });
    }
  };
  walk(error.issues, []);
  return issues;
}

/** Проверяет ввод правила. Отказ несёт путь до поля и код: текст на языке администратора подставляет страница. */
export function parseRule(input: unknown): { ok: true; rule: RuleDefinition } | { ok: false; issues: RuleIssue[] } {
  const parsed = ruleInput.safeParse(input);
  if (parsed.success) {
    const data = parsed.data;
    return {
      ok: true,
      rule: { ...(data.ruleId ? { ruleId: data.ruleId } : {}), name: data.name, event: data.event as RuleDefinition['event'], hours: data.hours ?? null, conditions: data.conditions as Conditions, actions: data.actions, isStop: data.isStop },
    };
  }
  return { ok: false, issues: issuesOf(parsed.error) };
}

