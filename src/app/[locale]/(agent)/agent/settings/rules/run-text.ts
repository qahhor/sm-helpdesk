import 'server-only';
import { getFormatter, getTranslations } from 'next-intl/server';
import type { ActionDone } from '@/modules/hdw/api';

// Что сделало (или сделало бы) действие правила, словами на языке страницы: для пробного прогона и журнала
// срабатываний (FR-AUTO-08, 09) и для итога запуска макроса. Те же подписи, что у записи "Правило ..." в истории
// обращения, и причина отказа.

export type ActionTexts = (actions: readonly ActionDone[], failedKey: 'dry.failed' | 'runs.notDone') => string[];

/** macro: действия выполнил макрос. У ответа по шаблону тогда своя подпись: макрос его не отправляет, а вставляет в поле ответа. */
export async function actionTexts(opts: { macro?: boolean } = {}): Promise<ActionTexts> {
  const t = await getTranslations('agent');
  const format = await getFormatter();
  const label = (action: string, value: string | null | undefined): string => {
    if (value === null || value === undefined) return '';
    if (action === 'set_status') return t.has(`queues.statuses.${value}`) ? t(`queues.statuses.${value}`) : value;
    if (action === 'set_priority') return value.toUpperCase();
    if (action === 'set_queue') return t.has(`ticket.lines.${value}`) ? t(`ticket.lines.${value}`) : value;
    if (action === 'snooze') return Number.isNaN(Date.parse(value)) ? value : format.dateTime(new Date(value), { dateStyle: 'medium', timeStyle: 'short' });
    return value;
  };
  return (actions, failedKey) =>
    actions.flatMap((item): string[] => {
      if (!t.has(`ticket.ruleActions.${item.action}`)) return [];
      const name = t(`ticket.ruleActionNames.${item.action}`);
      if (!item.ok) {
        const reason = item.detail && t.has(`settings.rules.details.${item.detail}`) ? t(`settings.rules.details.${item.detail}`) : t('settings.rules.details.unknown');
        return [t(`settings.rules.${failedKey}`, { name, reason })];
      }
      if (item.unchanged) return [`${name}: ${t('ticket.ruleActions.unchanged')}`];
      const key = opts.macro && t.has(`ticket.macroActions.${item.action}`) ? `ticket.macroActions.${item.action}` : `ticket.ruleActions.${item.action}`;
      return [t(key, { from: label(item.action, item.from), to: label(item.action, item.to) }).trim()];
    });
}
