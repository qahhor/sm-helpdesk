import * as z from 'zod';
import { cleanUserText } from '@/modules/hdc/pref';
import { IMPACTS, PRIORITIES, QUEUES, TICKET_SOURCES, TICKET_STATUSES, TICKET_TYPES } from '@/modules/hdt/pref';
import { MAX_ACTIONS, MAX_CONDITIONS, MAX_HOURS, MAX_SNOOZE_HOURS, NOTIFY_ROLES, ORG_CATEGORIES, RULE_EVENT_KINDS, RULE_NAME_MAX, RULE_NOTE_MAX, RULE_STATUS_TARGETS } from './pref';

// Модуль hdw: схема правила автоматизации (FR-AUTO-01, 03, 04, 05; план M8, задача 3). Правило это данные: событие,
// условия ("все" или "любое") и действия из закрытого перечня. Формул, скриптов и регулярных выражений нет.
// Чистый файл без базы: существование очередей, людей, тегов и шаблонов проверяет слой api при сохранении.

/** Коды отказов схемы: слой api отдаёт их редактору вместе с путём до поля. */
export const RULE_ISSUE_CODES = ['event_not_ready', 'condition_not_ready', 'hours_required', 'hours_not_allowed', 'reference_missing', 'invalid'] as const;
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
    z.strictObject({ field: z.literal('tags'), op: z.enum(['has_any', 'has_all', 'has_none']), values: values(z.uuid()) }),
    z.strictObject({ field: z.literal('text'), op: z.enum(['contains_any', 'contains_none']), words: z.array(word).min(1).max(10) }),
    z.strictObject({ field: z.literal('work_time'), op: z.literal('is'), value: z.enum(['working', 'off']) }),
    z.strictObject({ field: z.literal('hours_since_client'), op: z.enum(['gte', 'lt']), value: hours }),
    z.strictObject({ field: z.literal('hours_since_staff'), op: z.enum(['gte', 'lt']), value: hours }),
    z.strictObject({ field: z.literal('rating'), op: z.enum(['is', 'lte', 'gte']), value: z.number().int().min(1).max(5) }),
  ]),
  // Условия ТЗ, для которых ещё нет данных (вехи M5b и M5c): названы, но не принимаются.
  z.looseObject({ field: z.enum(['signature', 'known_problem', 'ai_reason']) }).refine(() => false, { error: 'condition_not_ready' }),
]);
export type Condition = Exclude<z.infer<typeof condition>, { field: 'signature' | 'known_problem' | 'ai_reason' }>;

const conditions = z.strictObject({ match: z.enum(['all', 'any']), items: z.array(condition).max(MAX_CONDITIONS) });
export type Conditions = { match: 'all' | 'any'; items: Condition[] };

const notifyTarget = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('user'), userId: z.uuid() }),
  z.strictObject({ kind: z.literal('role'), role: z.enum(NOTIFY_ROLES) }),
  z.strictObject({ kind: z.literal('oncall') }),
]);
export type NotifyTarget = z.infer<typeof notifyTarget>;

const action = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('set_queue'), queue: z.enum(QUEUES) }),
  z.strictObject({ action: z.literal('assign'), userId: z.uuid() }),
  z.strictObject({ action: z.literal('assign_round_robin') }),
  z.strictObject({ action: z.literal('set_priority'), priority: z.enum(PRIORITIES) }),
  z.strictObject({ action: z.literal('add_tag'), tagId: z.uuid() }),
  z.strictObject({ action: z.literal('remove_tag'), tagId: z.uuid() }),
  z.strictObject({ action: z.literal('add_note'), text: z.string().overwrite(cleanUserText).trim().min(1).max(RULE_NOTE_MAX) }),
  z.strictObject({ action: z.literal('reply_template'), templateId: z.uuid() }),
  z.strictObject({ action: z.literal('notify'), target: notifyTarget }),
  z.strictObject({ action: z.literal('snooze'), hours: z.number().int().min(1).max(MAX_SNOOZE_HOURS) }),
  z.strictObject({ action: z.literal('set_status'), status: z.enum(RULE_STATUS_TARGETS) }),
  z.strictObject({ action: z.literal('webhook'), endpointId: z.uuid() }),
]);
export type RuleAction = z.infer<typeof action>;
export type RuleActionKind = RuleAction['action'];

const actions = z.array(action).min(1).max(MAX_ACTIONS);

/** Условия и действия сохранённого правила: той же схемой читает их применение, негодное правило не выполняется. */
export const storedRule = z.object({ conditions, actions });

export const ruleInput = z
  .strictObject({
    ruleId: z.uuid().optional(),
    name: z.string().overwrite(cleanUserText).trim().min(1).max(RULE_NAME_MAX),
    event: z.enum(RULE_EVENT_KINDS).refine((kind) => kind !== 'ai_handoff', { error: 'event_not_ready' }),
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
  event: Exclude<(typeof RULE_EVENT_KINDS)[number], 'ai_handoff'>;
  hours: number | null;
  conditions: Conditions;
  actions: RuleAction[];
  isStop: boolean;
};

const CODES: ReadonlySet<string> = new Set(RULE_ISSUE_CODES);

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
  walk(parsed.error.issues, []);
  return { ok: false, issues };
}
