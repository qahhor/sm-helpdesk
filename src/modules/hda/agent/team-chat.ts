import { createTranslator } from 'next-intl';
import type { Locale } from '@/i18n/locales';
import en from '../../../../messages/en.json';
import ru from '../../../../messages/ru.json';
import uz from '../../../../messages/uz.json';
import { REPORT_CHAT_KEYS, REPORT_CHAT_TICKETS_MAX, type ReportKind } from '../pref';

// Сообщение в служебный чат команды по сводке AI-сотрудника (веха M8b, задача 10; FR-AGT-13, T35; план M8b, решение
// 24). Собирает портал по шаблону agent.teamChat из messages/*.json: вид сводки, числа по фиксированным ключам, номера
// обращений ссылками и ссылка на сводку. Текста и заголовка агента у функции на входе нет: в чат они не попадают.

const MESSAGES = { ru, uz, en } as const;

export type TeamChatFields = { kind: ReportKind; numbers: Partial<Record<(typeof REPORT_CHAT_KEYS)[number], number>>; ticketNumbers: readonly number[] };

export function teamChatText(fields: TeamChatFields, opts: { locale: Locale; hubUrl: string; reportId: string }): string {
  const t = createTranslator({ locale: opts.locale, messages: MESSAGES[opts.locale], namespace: 'agent.teamChat' });
  const base = opts.hubUrl.replace(/\/+$/, '');
  const lines = [t('title', { kind: t(`kinds.${fields.kind}`) })];
  for (const key of REPORT_CHAT_KEYS) {
    const value = fields.numbers[key];
    if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) lines.push(t(`numbers.${key}`, { count: value }));
  }
  const numbers = fields.ticketNumbers.filter((n) => Number.isSafeInteger(n) && n > 0).slice(0, REPORT_CHAT_TICKETS_MAX);
  if (numbers.length > 0) {
    lines.push(t('tickets'));
    for (const n of numbers) lines.push(`#${n} ${base}/${opts.locale}/agent/tickets/${n}`);
  }
  lines.push(t('open', { url: `${base}/${opts.locale}/agent/digests/${opts.reportId}` }));
  return lines.join('\n');
}
