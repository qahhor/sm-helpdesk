import 'server-only';
import { getLocale, getTranslations } from 'next-intl/server';
import { AI_HANDOFF_REASONS } from '@/modules/hdt/api/ai';
import type { StaffContext } from '@/modules/hdu/api';
import { builtinRule, type RuleRecord, ruleOptions } from '@/modules/hdw/api';
import type { RuleEditorLabels, RuleEditorOptions } from './RuleEditor';
import { ACTION_KINDS, CONDITION_FIELDS, FIELD_OPS, NO_MODULE } from './rule-draft';

// Списки и подписи редактора правила на языке страницы (FR-AUTO-01, 03, 04). Значения условий и действий берутся
// из справочников модуля правил: очереди, сотрудники, теги, шаблоны, модули. Клиентский редактор получает готовые
// строки свойствами: каталог сообщений в браузер не уходит.

export async function ruleEditorProps(staff: StaffContext, rule: RuleRecord | null): Promise<{ options: RuleEditorOptions; labels: RuleEditorLabels; eventLock: string | null }> {
  const t = await getTranslations('agent');
  const tc = await getTranslations('client.tickets');
  const r = await getTranslations('agent.settings.rules');
  const orgIds = (rule?.conditions.items ?? []).flatMap((item) => (item.field === 'org' ? item.values : []));
  const lists = await ruleOptions(staff, { locale: await getLocale(), orgIds: [...new Set(orgIds)].slice(0, 200) });
  const upper = (value: string) => ({ value, label: value.toUpperCase() });
  // Предустановленное правило (FR-AUTO-12): его собственное действие есть только в его редакторе, событие не меняется.
  const shipped = builtinRule(rule?.pcode ?? null);

  const options: RuleEditorOptions = {
    events: lists.events.map((value) => ({ value, label: r(`events.${value}`) })),
    fields: CONDITION_FIELDS.map((value) => ({ value, label: r(`fields.${value}`) })),
    actions: [...ACTION_KINDS, ...(shipped ? [shipped.action] : [])].map((value) => ({ value, label: r(`actions.${value}`) })),
    values: {
      type: lists.types.map((value) => ({ value, label: t(`ticket.types.${value}`) })),
      module: [{ value: NO_MODULE, label: r('moduleNone') }, ...lists.modules.map((item) => ({ value: item.moduleId, label: item.name }))],
      priority: lists.priorities.map(upper),
      impact: lists.impacts.map((value) => ({ value, label: tc(`impacts.${value}`) })),
      status: lists.statuses.map((value) => ({ value, label: t(`queues.statuses.${value}`) })),
      queue: lists.queues.map((value) => ({ value, label: t(`ticket.lines.${value}`) })),
      source: lists.sources.map((value) => ({ value, label: t(`ticket.sources.${value}`) })),
      locale: lists.locales.map((value) => ({ value, label: t(`newTicket.locales.${value}`) })),
      org_category: lists.categories.map((value) => ({ value, label: value === 'none' ? r('categoryNone') : value })),
      org: lists.orgs.map((org) => ({ value: org.orgId, label: org.name })),
      tags: lists.tags.map((tag) => ({ value: tag.tagId, label: tag.name })),
      // Причина передачи от AI (план M5b, задача 8): перечень FR-AI-14.
      ai_reason: AI_HANDOFF_REASONS.map((value) => ({ value, label: t(`ticket.aiReasons.${value}`) })),
      // Веха M5c (решение 11): сигнатура ошибки и известная проблема.
      signature: (['present', 'absent'] as const).map((value) => ({ value, label: r(`flags.signature.${value}`) })),
      known_problem: (['linked', 'unlinked'] as const).map((value) => ({ value, label: r(`flags.known_problem.${value}`) })),
    },
    workTime: (['working', 'off'] as const).map((value) => ({ value, label: r(`workTime.${value}`) })),
    actionValues: {
      set_queue: lists.queues.map((value) => ({ value, label: t(`ticket.lines.${value}`) })),
      // Исполнителем становится только сотрудник, который ведёт обращения.
      assign: lists.staff.filter((member) => member.role !== 'product').map((member) => ({ value: member.userId, label: member.name })),
      set_priority: lists.priorities.map(upper),
      add_tag: lists.tags.map((tag) => ({ value: tag.tagId, label: tag.name })),
      remove_tag: lists.tags.map((tag) => ({ value: tag.tagId, label: tag.name })),
      reply_template: lists.templates.map((item) => ({ value: item.templateId, label: item.isEnabled ? item.title : r('templateDisabled', { title: item.title }) })),
      set_status: lists.statusTargets.map((value) => ({ value, label: t(`queues.statuses.${value}`) })),
      webhook: lists.webhooks.map((item) => ({ value: item.endpointId, label: item.isEnabled ? item.name : r('webhookDisabled', { name: item.name }) })),
      link_known_problem: lists.problems.map((item) => ({ value: String(item.number), label: `KP-${item.number} ${item.internalTitle}` })),
    },
    notify: {
      oncall: { value: 'oncall', label: r('targets.oncall') },
      roles: lists.roles.map((value) => ({ value: `role:${value}`, label: t(`settings.staff.roles.${value}`) })),
      staff: lists.staff.map((member) => ({ value: `user:${member.userId}`, label: member.name })),
    },
  };

  const e = (key: string) => r(`editor.${key}`);
  /** Шаблон с подстановкой, которую заполняет редактор: {n}, {name}, {count}. */
  const template = (key: string, ...names: string[]) => r(key, Object.fromEntries(names.map((name) => [name, `{${name}}`])));
  const labels: RuleEditorLabels = {
    name: e('name'),
    nameHint: e('nameHint'),
    when: e('when'),
    event: e('event'),
    hours: e('hours'),
    hoursHint: e('hoursHint'),
    if: e('if'),
    match: e('match'),
    matchAll: e('matchAll'),
    matchAny: e('matchAny'),
    noConditions: e('noConditions'),
    then: e('then'),
    noActions: e('noActions'),
    addCondition: e('addCondition'),
    addAction: e('addAction'),
    conditionRow: template('editor.conditionRow', 'n'),
    actionRow: template('editor.actionRow', 'n'),
    removeCondition: template('editor.removeCondition', 'n'),
    removeAction: template('editor.removeAction', 'n'),
    field: e('field'),
    operator: e('operator'),
    value: e('value'),
    action: e('action'),
    pick: e('pick'),
    addValue: e('addValue'),
    add: e('add'),
    removeValue: template('editor.removeValue', 'name'),
    unknown: e('unknown'),
    words: e('words'),
    hoursValue: e('hoursValue'),
    rating: e('rating'),
    orgSearch: e('orgSearch'),
    orgFind: e('orgFind'),
    orgEmpty: e('orgEmpty'),
    orgAdd: template('editor.orgAdd', 'name'),
    stop: e('stop'),
    save: e('save'),
    newDisabled: e('newDisabled'),
    reauth: r('reauth'),
    ops: Object.fromEntries([...new Set(Object.values(FIELD_OPS).flat())].map((op) => [op, r(`ops.${op}`)])),
    actionValues: Object.fromEntries(['set_queue', 'assign', 'set_priority', 'add_tag', 'remove_tag', 'add_note', 'reply_template', 'notify', 'snooze', 'set_status', 'webhook', 'link_known_problem'].map((key) => [key, r(`actionValues.${key}`)])),
    targets: { roles: r('targets.roles'), staff: r('targets.staff') },
    issues: {
      event_not_ready: r('issues.event_not_ready'),
      condition_not_ready: r('issues.condition_not_ready'),
      hours_required: r('issues.hours_required'),
      hours_not_allowed: r('issues.hours_not_allowed'),
      reference_missing: r('issues.reference_missing'),
      builtin_only: r('issues.builtin_only'),
      builtin_event: r('issues.builtin_event'),
      invalid: r('issues.invalid'),
      name: r('issues.name'),
      actions: r('issues.actions'),
      conditions: r('issues.conditions'),
      general: r('issues.general'),
    },
    dry: {
      title: r('dry.title'),
      scopeHint: r('dry.scopeHint'),
      run: r('dry.run'),
      count: template('dry.count', 'count'),
      none: r('dry.none'),
      matches: r('dry.matches'),
      would: r('dry.would'),
      safe: r('dry.safe'),
      more: template('dry.more', 'shown', 'count'),
    },
  };
  const eventLock = shipped ? [e('builtinEvent'), ...shipped.extraEvents.map((event) => r('editor.alsoOn', { event: r(`events.${event}`) }))].join(' ') : null;
  return { options, labels, eventLock };
}
