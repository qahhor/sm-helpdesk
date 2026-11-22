import { createTranslator } from 'next-intl';
import type { Locale } from '@/i18n/locales';
import en from '../../../messages/en.json';
import ru from '../../../messages/ru.json';
import uz from '../../../messages/uz.json';

// Сообщения поддержки, которые пишет система (автозакрытие, FR-TK-10, FR-TK-15). Лежат в messages/*.json
// в пространстве client.tickets.system: их читает клиент, поэтому они проходят проверки слов портала.

const MESSAGES = { ru, uz, en } as const;

export type SystemTextKey = 'autoCloseResolved' | 'autoCloseWaiting';

/** Текст на языке обращения; неизвестный язык: русский. days: срок автозакрытия из настроек (решение 24 вехи M4). */
export function systemText(locale: string, key: SystemTextKey, values: { days: number }): string {
  const lang: Locale = locale === 'uz' || locale === 'en' ? locale : 'ru';
  return createTranslator({ locale: lang, messages: MESSAGES[lang], namespace: 'client.tickets.system' })(key, values);
}

export type StaffSystemTextKey = 'emailReview';

/** Внутренняя заметка системы для сотрудника (пространство agent.ticket) на языке обращения. */
export function staffSystemText(locale: string, key: StaffSystemTextKey, values: Record<string, string>): string {
  const lang: Locale = locale === 'uz' || locale === 'en' ? locale : 'ru';
  return createTranslator({ locale: lang, messages: MESSAGES[lang], namespace: 'agent.ticket' })(key, values);
}
