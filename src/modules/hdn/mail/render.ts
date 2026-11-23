import { createTranslator } from 'next-intl';
import type { Locale } from '@/i18n/locales';
import en from '../../../../messages/en.json';
import ru from '../../../../messages/ru.json';
import uz from '../../../../messages/uz.json';
import { esc, markdownToHtml } from './html';
import { LINK_COLOR, PARAGRAPH, renderLayout, renderLayoutText } from './layout';
import { noLinks, personName, plain } from './sanitize';

// Модуль hdn: письма вехи M4 (решения 4, 6, 7, 8 и 23). Тексты в messages/*.json (mail.*), три языка (FR-NT-02).
// В письмах нет внутренних заметок и текста чужих обращений (FR-NT-10): ответ сотрудника приходит только из
// публичного сообщения этого обращения, его выбирает модуль hdt.

const MESSAGES = { ru, uz, en } as const;

export const MAIL_TEMPLATES = [
  'ticket_created',
  'ticket_reply',
  'ticket_status',
  'ticket_resolved',
  'waiting_reminder',
  'unidentified_ack',
  'staff_mention',
  'staff_breach',
  'staff_update_due',
  'holidays_reminder',
  'oncall_p1',
  'inbound_test',
  'ops_alert',
] as const;
export type MailTemplate = (typeof MAIL_TEMPLATES)[number];

/** Общее для всех писем: адрес портала, показываемый адрес поддержки (решение 23), ссылка на настройки отключаемых писем. */
export type MailCommon = { hubUrl: string; supportAddress: string | null; settingsUrl?: string | null };

type TicketRef = { number: number; title: string; url: string };

export type MailPayload =
  | ({ template: 'ticket_created'; viaEmail: boolean } & TicketRef)
  | ({ template: 'ticket_reply'; body: string } & TicketRef)
  | ({ template: 'ticket_status'; status: 'waiting_customer' | 'in_development' | 'closed'; auto?: boolean; mergedInto?: number } & TicketRef)
  | ({ template: 'ticket_resolved' } & TicketRef)
  | ({ template: 'waiting_reminder'; closeInDays: number } & TicketRef)
  | { template: 'unidentified_ack'; number: number; title: string }
  | ({ template: 'staff_mention'; author: string } & TicketRef)
  | ({ template: 'staff_breach'; kind: 'first_response' | 'resolution' } & TicketRef)
  | ({ template: 'staff_update_due' } & TicketRef)
  | { template: 'holidays_reminder'; year: number; url: string }
  | ({ template: 'oncall_p1'; orgName: string } & TicketRef)
  | { template: 'inbound_test'; address: string; token: string }
  // Сигнал дежурным о состоянии портала (ТЗ 13.8): готовый текст с числами, без данных клиентов.
  | { template: 'ops_alert'; text: string; url: string };

export type MailData = MailPayload & MailCommon;

export type RenderedMail = { subject: string; html: string; text: string };

/** Длина темы обращения в теме письма, знаков. */
export const SUBJECT_TITLE_MAX = 120;
const TITLE_MAX = 200;
const NAME_MAX = 60;

/** Тема письма по обращению (FR-EM-01): [SUP-1042] <тема>, без переводов строк, не длиннее 120 знаков. */
export function ticketSubject(number: number, title: string): string {
  const text = plain(title, Number.MAX_SAFE_INTEGER);
  const chars = Array.from(text);
  const short = chars.length > SUBJECT_TITLE_MAX ? `${chars.slice(0, SUBJECT_TITLE_MAX - 3).join('')}...` : text;
  return `[SUP-${number}] ${short}`;
}

const translatorOf = (locale: Locale) => createTranslator({ locale, messages: MESSAGES[locale], namespace: 'mail' });

/** Строка "Ответьте на это письмо" на всех языках: по ней разбор входящего письма отрезает цитату (задача 7). */
export const REPLY_MARKERS: readonly string[] = (['ru', 'uz', 'en'] as const).map((locale) => MESSAGES[locale].mail.layout.replyAbove);

type Body = { subject: string; heading: string | null; text: string; html?: string; button: { label: string; url: string } | null; reply: boolean; signature: boolean };

function body(payload: MailPayload, t: ReturnType<typeof translatorOf>): Body {
  const open = (url: string) => ({ label: t('layout.open'), url });
  switch (payload.template) {
    case 'ticket_created': {
      const values = { number: payload.number, title: noLinks(payload.title, TITLE_MAX) };
      return {
        subject: ticketSubject(payload.number, payload.title),
        heading: t('ticketCreated.heading', values),
        text: payload.viaEmail ? t('ticketCreated.viaEmail', values) : t('ticketCreated.text', values),
        button: open(payload.url),
        reply: true,
        signature: false,
      };
    }
    case 'ticket_reply': {
      const markdown = payload.body.trim();
      return {
        subject: ticketSubject(payload.number, payload.title),
        heading: t('ticketReply.heading', { number: payload.number }),
        text: markdown,
        html: markdownToHtml(markdown, { paragraph: PARAGRAPH, linkColor: LINK_COLOR }),
        button: open(payload.url),
        reply: true,
        signature: true,
      };
    }
    case 'ticket_status': {
      const values = { number: payload.number, title: noLinks(payload.title, TITLE_MAX), into: payload.mergedInto ?? 0 };
      const key =
        payload.mergedInto !== undefined
          ? 'ticketStatus.merged'
          : payload.status === 'closed' && payload.auto
            ? 'ticketStatus.autoClosed'
            : (`ticketStatus.${payload.status}` as const);
      return {
        subject: ticketSubject(payload.number, payload.title),
        heading: t('ticketStatus.heading', { number: payload.number }),
        text: t(key, values),
        button: open(payload.url),
        reply: true,
        signature: false,
      };
    }
    case 'ticket_resolved': {
      const values = { number: payload.number, title: noLinks(payload.title, TITLE_MAX) };
      return {
        subject: ticketSubject(payload.number, payload.title),
        heading: t('ticketResolved.heading', values),
        text: t('ticketResolved.text', values),
        button: { label: t('ticketResolved.button'), url: payload.url },
        reply: true,
        signature: false,
      };
    }
    case 'waiting_reminder':
      return {
        subject: ticketSubject(payload.number, payload.title),
        heading: t('waitingReminder.heading'),
        text: t('waitingReminder.text', { number: payload.number, title: noLinks(payload.title, TITLE_MAX), days: payload.closeInDays }),
        button: open(payload.url),
        reply: true,
        signature: false,
      };
    case 'unidentified_ack':
      // Неопознанный отправитель получает только номер (FR-EM-05): без ссылок на портал и решения. Тема его письма не
      // повторяется: адрес мог быть подделан, и письмо Smartup с подписью DKIM не должно нести чужой текст (угроза T32).
      return {
        subject: `[SUP-${payload.number}] ${t('unidentifiedAck.subject')}`,
        heading: t('unidentifiedAck.heading'),
        text: t('unidentifiedAck.text', { number: payload.number }),
        button: null,
        reply: true,
        signature: true,
      };
    case 'staff_mention':
      return {
        subject: ticketSubject(payload.number, payload.title),
        heading: t('staffMention.heading'),
        text: t('staffMention.text', { author: personName(payload.author, NAME_MAX, t('layout.signature')), number: payload.number, title: noLinks(payload.title, TITLE_MAX) }),
        button: open(payload.url),
        reply: false,
        signature: false,
      };
    case 'staff_breach':
      return {
        subject: ticketSubject(payload.number, payload.title),
        heading: t('staffBreach.heading'),
        text: t(`staffBreach.${payload.kind}`, { number: payload.number, title: noLinks(payload.title, TITLE_MAX) }),
        button: open(payload.url),
        reply: false,
        signature: false,
      };
    case 'staff_update_due':
      return {
        subject: ticketSubject(payload.number, payload.title),
        heading: t('staffUpdateDue.heading'),
        text: t('staffUpdateDue.text', { number: payload.number, title: noLinks(payload.title, TITLE_MAX) }),
        button: open(payload.url),
        reply: false,
        signature: false,
      };
    case 'holidays_reminder':
      return {
        subject: t('holidaysReminder.subject', { year: payload.year }),
        heading: t('holidaysReminder.subject', { year: payload.year }),
        text: t('holidaysReminder.text', { year: payload.year }),
        button: { label: t('holidaysReminder.button'), url: payload.url },
        reply: false,
        signature: false,
      };
    case 'oncall_p1':
      return {
        subject: ticketSubject(payload.number, t('oncallP1.subject')),
        heading: t('oncallP1.subject'),
        text: t('oncallP1.text', { orgName: noLinks(payload.orgName, NAME_MAX), number: payload.number, title: noLinks(payload.title, TITLE_MAX) }),
        button: { label: t('oncallP1.button'), url: payload.url },
        reply: false,
        signature: false,
      };
    case 'inbound_test':
      return {
        subject: t('inboundTest.subject', { token: payload.token }),
        heading: null,
        text: t('inboundTest.text', { address: payload.address }),
        button: null,
        reply: false,
        signature: false,
      };
    case 'ops_alert':
      return {
        subject: t('opsAlert.subject'),
        heading: t('opsAlert.subject'),
        text: payload.text,
        button: { label: t('opsAlert.button'), url: payload.url },
        reply: false,
        signature: false,
      };
  }
}

export async function renderMail(template: MailTemplate, locale: Locale, data: MailData): Promise<RenderedMail> {
  if (data.template !== template) throw new Error('почта: шаблон не совпадает с данными');
  const t = translatorOf(locale);
  const b = body(data, t);
  const layoutText = {
    replyAbove: t('layout.replyAbove'),
    signature: t('layout.signature'),
    support: data.supportAddress ? t('layout.support', { address: data.supportAddress }) : null,
    settings: t('layout.settings'),
    contacts: t('layout.contacts'),
  };
  const shared = { hubUrl: data.hubUrl, heading: b.heading, button: b.button, replyHint: b.reply, signature: b.signature, settingsUrl: data.settingsUrl ?? null, text: layoutText };
  const bodyHtml = b.html ?? b.text.split('\n\n').map((paragraph) => `<p style="${PARAGRAPH}">${esc(paragraph)}</p>`).join('');
  return {
    subject: b.subject,
    html: renderLayout({ ...shared, lang: locale, title: b.subject, bodyHtml }),
    text: renderLayoutText({ ...shared, bodyText: b.text }),
  };
}

/** Простое письмо (M1) в общей оболочке: без кнопки, строки для ответа и ссылки на настройки. */
export function wrapPlainMail(locale: Locale, input: { subject: string; text: string; bodyHtml: string; hubUrl: string }): string {
  const t = translatorOf(locale);
  return renderLayout({
    hubUrl: input.hubUrl,
    lang: locale,
    title: input.subject,
    heading: null,
    bodyHtml: input.bodyHtml,
    button: null,
    replyHint: false,
    signature: false,
    settingsUrl: null,
    text: { replyAbove: t('layout.replyAbove'), signature: t('layout.signature'), support: null, settings: t('layout.settings'), contacts: t('layout.contacts') },
  });
}
