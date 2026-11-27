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

export type CodeScanChatFields = { repository: string; commit: string; added: number; changed: number; removed: number };

/**
 * Сводка о сканировании кода в чат команды (веха M8c, FR-CODE-14; план M8c, решение 15): репозиторий, версия, числа
 * и ссылка на очередь утверждения. Выводов агента у функции на входе нет.
 */
export function codeScanChatText(fields: CodeScanChatFields, opts: { locale: Locale; hubUrl: string }): string {
  const t = createTranslator({ locale: opts.locale, messages: MESSAGES[opts.locale], namespace: 'agent.teamChat.codeScan' });
  const base = opts.hubUrl.replace(/\/+$/, '');
  const safe = (value: number) => (Number.isSafeInteger(value) && value >= 0 ? value : 0);
  return [
    t('title', { repository: fields.repository.replace(/[^a-z0-9._-]/g, ''), commit: fields.commit.replace(/[^0-9a-f]/g, '').slice(0, 12) }),
    t('added', { count: safe(fields.added) }),
    t('changed', { count: safe(fields.changed) }),
    t('removed', { count: safe(fields.removed) }),
    t('open', { url: `${base}/${opts.locale}/agent/code-knowledge` }),
  ].join('\n');
}
