// Черновик правила автоматизации в редакторе (FR-AUTO-01; план M8, задача 4). Чистый файл без сервера: его берут и
// клиентский редактор, и серверные действия. Строки условий и действий хранятся в виде, удобном полям формы, и
// превращаются в ввод схемы правила (src/modules/hdw/rule-schema.ts). Проверяет ввод только сервер: черновик отдаёт
// и неполные строки, отказ схемы возвращается с путём до строки.

export type IssueCode = 'event_not_ready' | 'condition_not_ready' | 'hours_required' | 'hours_not_allowed' | 'reference_missing' | 'builtin_only' | 'builtin_event' | 'invalid';
export type Issue = { path: string; code: IssueCode };

/** Строка условия. values: выбранные значения списка; text: слова через запятую, число часов, оценка или вид времени. */
export type ConditionDraft = { key: number; field: string; op: string; values: string[]; text: string };
/**
 * Строка действия. value: очередь, сотрудник (у макроса ещё "me": тот, кто запустил макрос), приоритет, тег, шаблон,
 * статус, часы, адрес вебхука или получатель уведомления ("oncall", "role:<роль>", "user:<идентификатор>");
 * text: текст заметки.
 */
export type ActionDraft = { key: number; action: string; value: string; text: string };
export type RuleDraft = { ruleId?: string; name: string; event: string; hours: string; match: 'all' | 'any'; conditions: ConditionDraft[]; actions: ActionDraft[]; isStop: boolean };

export const EMPTY_DRAFT: RuleDraft = { name: '', event: 'ticket_created', hours: '', match: 'all', conditions: [], actions: [], isStop: false };

/** Вид поля условия: от него зависят операторы и поле значения. */
export type FieldKind = 'list' | 'tags' | 'words' | 'work' | 'hours' | 'rating' | 'flag';
export const FIELD_KINDS = {
  priority: 'list',
  type: 'list',
  module: 'list',
  impact: 'list',
  status: 'list',
  queue: 'list',
  source: 'list',
  locale: 'list',
  org_category: 'list',
  org: 'list',
  ai_reason: 'list',
  tags: 'tags',
  text: 'words',
  work_time: 'work',
  hours_since_client: 'hours',
  hours_since_staff: 'hours',
  rating: 'rating',
  // Веха M5c (решение 11): есть ли сигнатура ошибки, привязано ли обращение к известной проблеме.
  signature: 'flag',
  known_problem: 'flag',
} as const satisfies Record<string, FieldKind>;
export type ConditionField = keyof typeof FIELD_KINDS;
export const CONDITION_FIELDS = Object.keys(FIELD_KINDS) as ConditionField[];
export const FIELD_OPS = {
  list: ['is', 'is_not'],
  tags: ['has_any', 'has_all', 'has_none'],
  words: ['contains_any', 'contains_none'],
  work: ['is'],
  hours: ['gte', 'lt'],
  rating: ['is', 'lte', 'gte'],
  flag: ['is'],
} as const satisfies Record<FieldKind, readonly string[]>;
export type ConditionOp = (typeof FIELD_OPS)[FieldKind][number];

export const kindOf = (field: string): FieldKind => (FIELD_KINDS as Record<string, FieldKind>)[field] ?? 'list';

/** Действия, которые предлагает редактор. Вебхук выбирается из списка адресов администратора (FR-AUTO-10). */
export const ACTION_KINDS = ['set_queue', 'assign', 'assign_round_robin', 'set_priority', 'add_tag', 'remove_tag', 'add_note', 'reply_template', 'notify', 'snooze', 'set_status', 'webhook', 'link_known_problem', 'request_code_analysis'] as const;
export type ActionKind = (typeof ACTION_KINDS)[number];

/** Значение "тот, кто запустил макрос" в списке исполнителей: в макросе это действие assign_me. */
export const ASSIGN_ME = 'me';

/** Значение "модуль не указан" в списке модулей: в правиле это null. */
export const NO_MODULE = 'none';

const numberOf = (text: string): number | null => {
  const value = text.trim() === '' ? Number.NaN : Number(text.trim().replace(',', '.'));
  return Number.isFinite(value) ? value : null;
};
const wordsOf = (text: string): string[] =>
  text
    .split(',')
    .map((word) => word.trim())
    .filter((word) => word !== '');

function conditionOf(row: ConditionDraft): Record<string, unknown> {
  const base = { field: row.field, op: row.op };
  switch (kindOf(row.field)) {
    case 'list':
      return { ...base, values: row.field === 'module' ? row.values.map((value) => (value === NO_MODULE ? null : value)) : row.values };
    case 'tags':
      return { ...base, values: row.values };
    case 'words':
      return { ...base, words: wordsOf(row.text) };
    case 'work':
    case 'flag':
      return { ...base, value: row.text };
    case 'hours':
    case 'rating':
      return { ...base, value: numberOf(row.text) };
  }
}

function notifyTarget(value: string): Record<string, unknown> {
  if (value === 'oncall') return { kind: 'oncall' };
  if (value.startsWith('role:')) return { kind: 'role', role: value.slice(5) };
  return { kind: 'user', userId: value.startsWith('user:') ? value.slice(5) : value };
}

function actionOf(row: ActionDraft): Record<string, unknown> {
  const action = row.action;
  switch (action) {
    case 'set_queue':
      return { action, queue: row.value };
    case 'assign':
      return row.value === ASSIGN_ME ? { action: 'assign_me' } : { action, userId: row.value };
    case 'set_priority':
      return { action, priority: row.value };
    case 'add_tag':
    case 'remove_tag':
      return { action, tagId: row.value };
    case 'add_note':
      return { action, text: row.text };
    case 'reply_template':
      return { action, templateId: row.value };
    case 'notify':
      return { action, target: notifyTarget(row.value) };
    case 'snooze':
      return { action, hours: numberOf(row.value) };
    case 'set_status':
      return { action, status: row.value };
    case 'webhook':
      return { action, endpointId: row.value };
    case 'link_known_problem':
      return { action, problemNumber: numberOf(row.value) };
    default:
      return { action };
  }
}

export type RulePayload = {
  ruleId?: string;
  name: string;
  event: string;
  hours?: number | null;
  conditions: { match: 'all' | 'any'; items: Record<string, unknown>[] };
  actions: Record<string, unknown>[];
  isStop: boolean;
};

/** Действия для схемы правила или макроса из строк черновика. */
export const actionsPayload = (rows: readonly ActionDraft[]): Record<string, unknown>[] => rows.map(actionOf);

/** Ввод схемы правила из черновика. Часы отдаются только у события "нет активности". */
export function payloadOf(draft: RuleDraft): RulePayload {
  return {
    ...(draft.ruleId ? { ruleId: draft.ruleId } : {}),
    name: draft.name,
    event: draft.event,
    ...(draft.event === 'no_activity' ? { hours: numberOf(draft.hours) } : {}),
    conditions: { match: draft.match, items: draft.conditions.map(conditionOf) },
    actions: draft.actions.map(actionOf),
    isStop: draft.isStop,
  };
}

type StoredRule = {
  ruleId?: string;
  name: string;
  event: string;
  hours: number | null;
  conditions: { match: 'all' | 'any'; items: readonly Record<string, unknown>[] };
  actions: readonly Record<string, unknown>[];
  isStop: boolean;
};

const text = (value: unknown): string => (value === null || value === undefined ? '' : String(value));

/** Строки действий из сохранённого правила или макроса. */
export function actionDrafts(actions: readonly Record<string, unknown>[]): ActionDraft[] {
  return actions.map((item, index) => {
    const target = (item.target ?? {}) as { kind?: string; role?: string; userId?: string };
    if (item.action === 'assign_me') return { key: index + 1, action: 'assign', value: ASSIGN_ME, text: '' };
    const value =
      item.action === 'notify'
        ? target.kind === 'oncall'
          ? 'oncall'
          : target.kind === 'role'
            ? `role:${text(target.role)}`
            : `user:${text(target.userId)}`
        : text(item.queue ?? item.userId ?? item.priority ?? item.tagId ?? item.templateId ?? item.hours ?? item.status ?? item.endpointId ?? item.problemNumber);
    return { key: index + 1, action: text(item.action), value, text: text(item.text) };
  });
}

/** Черновик из сохранённого правила. */
export function draftOf(rule: StoredRule): RuleDraft {
  return {
    ...(rule.ruleId ? { ruleId: rule.ruleId } : {}),
    name: rule.name,
    event: rule.event,
    hours: text(rule.hours),
    match: rule.conditions.match,
    conditions: rule.conditions.items.map((item, index) => ({
      key: index + 1,
      field: text(item.field),
      op: text(item.op),
      values: Array.isArray(item.values) ? item.values.map((value) => (value === null ? NO_MODULE : text(value))) : [],
      text: Array.isArray(item.words) ? item.words.join(', ') : text(item.value),
    })),
    actions: actionDrafts(rule.actions),
    isStop: rule.isStop,
  };
}

/** Коды отказов по пути: сам путь или поле внутри него. Повторы убраны. */
export function issuesAt(issues: readonly Issue[], path: string): IssueCode[] {
  return [...new Set(issues.filter((issue) => issue.path === path || issue.path.startsWith(`${path}.`)).map((issue) => issue.code))];
}

/** Отказы, которым нет места у поля или строки черновика: они показываются над формой. */
export function otherIssues(issues: readonly Issue[], conditions: number, actions: number): Issue[] {
  return issues.filter((issue) => {
    if (issue.path === 'name' || issue.path === 'hours' || issue.path === 'event') return false;
    const row = /^(conditions\.items|actions)\.(\d+)(?:\.|$)/.exec(issue.path);
    if (!row) return true;
    return Number(row[2]) >= (row[1] === 'actions' ? actions : conditions);
  });
}
