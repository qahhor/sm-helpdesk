// Модуль hdn: короткое сообщение в служебный чат дежурных о P1 (FR-SLA-07, решение 8 вехи M4) и уведомление
// правила автоматизации дежурным (FR-AUTO-04, веха M8): номер, название правила и ссылка.
// Номер, приоритет, организация и ссылка, без текста клиента (раздел 14.6 ТЗ). Чат служебный, по умолчанию русский.
// Тексты в messages/*.json, пространство bot (M4, мелкое 7).

import { createTranslator } from 'next-intl';
import type { Locale } from '@/i18n/locales';
import en from '../../../../messages/en.json';
import ru from '../../../../messages/ru.json';
import uz from '../../../../messages/uz.json';
import { noLinks } from '../mail/sanitize';

const MESSAGES = { ru, uz, en } as const;

export function oncallTelegramText(payload: Record<string, unknown>, hubUrl: string, locale: Locale = 'ru'): string {
  const t = createTranslator({ locale, messages: MESSAGES[locale], namespace: 'bot' });
  const number = typeof payload.number === 'number' ? payload.number : 0;
  const org = typeof payload.orgName === 'string' ? noLinks(payload.orgName, 100) : '';
  const url = typeof payload.url === 'string' && payload.url.startsWith('/') ? `${hubUrl}/${locale}${payload.url}` : `${hubUrl}/${locale}/agent/tickets/${number}`;
  if (payload.template === 'oncall_rule') return `${t('oncallRule', { number, rule: noLinks(typeof payload.rule === 'string' ? payload.rule : '', 120) })}\n${url}`;
  return `${org ? t('oncallP1Org', { number, org }) : t('oncallP1', { number })}\n${url}`;
}
