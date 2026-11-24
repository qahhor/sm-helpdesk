import 'server-only';
import { getTranslations } from 'next-intl/server';
import type { StaffContext } from '@/modules/hdu/api';
import { macroOptions } from '@/modules/hdw/api';
import type { ActionRowsOptions } from '../rules/ActionRows';
import { ASSIGN_ME } from '../rules/rule-draft';
import type { MacroEditorLabels } from './MacroEditor';

// Списки и подписи редактора макроса на языке страницы (FR-AG-15, UX-A-16). Подписи действий те же, что в редакторе
// правил; у ответа по шаблону своя: макрос шаблон не отправляет, а вставляет в поле ответа (решение 7 плана M8).

export async function macroEditorProps(staff: StaffContext): Promise<{ options: ActionRowsOptions; labels: MacroEditorLabels }> {
  const t = await getTranslations('agent');
  const r = await getTranslations('agent.settings.rules');
  const m = await getTranslations('agent.settings.macros');
  const lists = await macroOptions(staff);
  const upper = (value: string) => ({ value, label: value.toUpperCase() });
  const tags = lists.tags.map((tag) => ({ value: tag.tagId, label: tag.name }));
  const options: ActionRowsOptions = {
    actions: lists.actions.map((value) => ({ value, label: m.has(`actions.${value}`) ? m(`actions.${value}`) : r(`actions.${value}`) })),
    actionValues: {
      set_queue: lists.queues.map((value) => ({ value, label: t(`ticket.lines.${value}`) })),
      assign: [{ value: ASSIGN_ME, label: m('assignMe') }, ...lists.staff.map((member) => ({ value: member.userId, label: member.name }))],
      set_priority: lists.priorities.map(upper),
      add_tag: tags,
      remove_tag: tags,
      reply_template: lists.templates.map((item) => ({ value: item.templateId, label: item.isEnabled ? item.title : r('templateDisabled', { title: item.title }) })),
      set_status: lists.statusTargets.map((value) => ({ value, label: t(`queues.statuses.${value}`) })),
    },
  };
  /** Шаблон с подстановкой, которую заполняет редактор. */
  const template = (key: string, ...names: string[]) => r(key, Object.fromEntries(names.map((name) => [name, `{${name}}`])));
  const labels: MacroEditorLabels = {
    name: m('editor.name'),
    nameHint: m('editor.nameHint'),
    actionsTitle: m('editor.actionsTitle'),
    actionsHint: m('editor.actionsHint'),
    enabled: m('editor.enabled'),
    save: r('editor.save'),
    reauth: r('reauth'),
    noActions: r('editor.noActions'),
    addAction: r('editor.addAction'),
    actionRow: template('editor.actionRow', 'n'),
    removeAction: template('editor.removeAction', 'n'),
    value: r('editor.value'),
    action: r('editor.action'),
    pick: r('editor.pick'),
    unknown: r('editor.unknown'),
    actionValues: Object.fromEntries(['set_queue', 'assign', 'set_priority', 'add_tag', 'remove_tag', 'add_note', 'reply_template', 'snooze', 'set_status'].map((key) => [key, r(`actionValues.${key}`)])),
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
    },
  };
  return { options, labels };
}
