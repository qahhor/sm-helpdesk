import { createTranslator } from 'next-intl';
import type { Locale } from '@/i18n/locales';
import en from '../../../../messages/en.json';
import ru from '../../../../messages/ru.json';
import uz from '../../../../messages/uz.json';
import type { MailPayload, MailTemplate } from '../mail/render';
import { noLinks, plain } from '../mail/sanitize';

// Модуль hdn: короткое сообщение клиенту в Telegram (FR-NT-15; план M4b, задача 2; решение 2 вехи M4b).
// Номер, тема до 60 знаков, что произошло, кнопка "Открыть в портале". Текста ответа сотрудника нет: он
// остаётся в портале и в письме. Простой текст без режима разметки, тема без переводов строк и ссылок.

const MESSAGES = { ru, uz, en } as const;

/** Шаблоны событий обращения, о которых клиенту уходит сообщение в Telegram. */
export const TELEGRAM_TEMPLATES: ReadonlySet<MailTemplate> = new Set(['ticket_created', 'ticket_reply', 'ticket_status', 'ticket_resolved', 'waiting_reminder']);

/**
 * Telegram сам делает нажимаемыми домены в любом регистре букв, команды бота, упоминания и метки. В теме обращения
 * это текст клиента: точка, косая черта, знаки @ и # заменяются похожими знаками (итоговая проверка M4b, мелкое 1).
 * Дробь "5/7" и номер "№3" не трогаются: команда начинается с косой черты в начале слова, за которой идёт буква.
 */
function unlinked(text: string): string {
  const dotted = /[\p{L}\p{N}-]+\.\p{L}{2,}/u.test(text) ? text.replaceAll('.', '․') : text;
  return dotted
    .replace(/(^|\s)\/(?=[A-Za-z])/g, '$1∕')
    .replaceAll('@', '＠')
    .replace(/(^|\s)#(?=[\p{L}\p{N}])/gu, '$1＃');
}

/** Тема в сообщении: 57 знаков и многоточие, всего не длиннее 60. */
const TITLE_MAX = 57;

export type TelegramNotice = { text: string; button: { text: string; url: string } };

type TicketPayload = Extract<MailPayload, { template: 'ticket_created' | 'ticket_reply' | 'ticket_status' | 'ticket_resolved' | 'waiting_reminder' }>;

export function isTelegramPayload(payload: MailPayload): payload is TicketPayload {
  return TELEGRAM_TEMPLATES.has(payload.template);
}

export function telegramNoticeText(payload: TicketPayload, locale: Locale, hubUrl: string): TelegramNotice {
  const t = createTranslator({ locale, messages: MESSAGES[locale], namespace: 'bot.notify' });
  let event: string;
  switch (payload.template) {
    case 'ticket_created':
      event = t('created');
      break;
    case 'ticket_reply':
      event = t('reply');
      break;
    case 'ticket_status':
      event =
        payload.mergedInto !== undefined
          ? t('merged', { into: payload.mergedInto })
          : payload.status === 'closed' && payload.auto
            ? t('autoClosed')
            : t(payload.status);
      break;
    case 'ticket_resolved':
      event = t('resolved');
      break;
    case 'waiting_reminder':
      event = t('reminder', { days: payload.closeInDays });
      break;
  }
  // Кнопка ведёт только в портал: адрес строится из номера, а не из данных строки.
  const url = `${hubUrl}/${locale}/tickets/SUP-${payload.number}`;
  // Ссылки обезвреживаются во всей теме, затем она обрезается: длина не зависит от того, была ли в ней ссылка.
  const title = plain(unlinked(noLinks(payload.title, Number.MAX_SAFE_INTEGER)), TITLE_MAX);
  return { text: `SUP-${payload.number} · ${title}\n${event}`, button: { text: t('button'), url } };
}
