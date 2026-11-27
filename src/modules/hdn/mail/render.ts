import { createTranslator } from 'next-intl';
import type { Locale } from '@/i18n/locales';
import en from '../../../../messages/en.json';
import ru from '../../../../messages/ru.json';
import uz from '../../../../messages/uz.json';
import { esc, link, markdownToHtml } from './html';
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
  // Задача разработки закрыта (веха M8, FR-DEV-05): напоминание исполнителю обращения.
  'staff_dev_task_closed',
  'holidays_reminder',
  'oncall_p1',
  // Уведомления правил автоматизации (веха M8): сотруднику и дежурным.
  'staff_rule',
  'oncall_rule',
  // Оценка 1 или 2 (веха M8, FR-AUTO-12): уведомление предустановленного правила сотрудникам Customer Care.
  'staff_csat_low',
  'inbound_test',
  'ops_alert',
  // Идеи (веха M7, задача 8): клиенту о событии идеи; роли product о модерации, отборе и закрытой задаче разработки.
  'idea_status',
  'staff_idea_moderation',
  'staff_idea_cycle',
  'staff_idea_dev_task_closed',
  // Ответ Теза (веха M5b, FR-NT-11, FR-EM-12): решение из hdk_published и ссылки "Помогло", "Нужен сотрудник".
  'tez_answer',
  // Подтверждение без Теза при передаче ai_disabled и ai_limit (FR-AI-15).
  'tez_ack',
] as const;
export type MailTemplate = (typeof MAIL_TEMPLATES)[number];

/** Общее для всех писем: адрес портала, показываемый адрес поддержки (решение 23), ссылка на настройки отключаемых писем. */
export type MailCommon = { hubUrl: string; supportAddress: string | null; settingsUrl?: string | null };

type TicketRef = { number: number; title: string; url: string };

/** Событие идеи в письме клиенту (план M7, решение 15). */
export type IdeaMailEvent = 'published' | 'declined' | 'merged' | 'shortlisted' | 'selected' | 'in_development' | 'released' | 'comment_hidden' | 'official_reply';

export type MailPayload =
  | ({ template: 'ticket_created'; viaEmail: boolean } & TicketRef)
  | ({ template: 'ticket_reply'; body: string } & TicketRef)
  // rateUrl: страница оценки для автора закрытого обращения (FR-TK-11); оценка дописывается к адресу.
  | ({ template: 'ticket_status'; status: 'waiting_customer' | 'in_development' | 'closed'; auto?: boolean; mergedInto?: number; rateUrl?: string } & TicketRef)
  | ({ template: 'ticket_resolved' } & TicketRef)
  | ({ template: 'waiting_reminder'; closeInDays: number } & TicketRef)
  | { template: 'unidentified_ack'; number: number; title: string }
  | ({ template: 'staff_mention'; author: string } & TicketRef)
  | ({ template: 'staff_breach'; kind: 'first_response' | 'resolution' } & TicketRef)
  | ({ template: 'staff_update_due' } & TicketRef)
  // ref: номер задачи в таск-менеджере. Письмо уходит только сотруднику.
  | ({ template: 'staff_dev_task_closed'; ref: string } & TicketRef)
  | { template: 'holidays_reminder'; year: number; url: string }
  | ({ template: 'oncall_p1'; orgName: string } & TicketRef)
  | ({ template: 'staff_rule'; rule: string } & TicketRef)
  // Дежурным без темы обращения: это текст клиента (решение 0041). Только номер и название правила.
  | { template: 'oncall_rule'; rule: string; number: number; url: string }
  // Низкая оценка: только оценка, номер, тема и организация. Комментария и причины клиента в письме нет.
  | ({ template: 'staff_csat_low'; score: number; orgName: string } & TicketRef)
  | { template: 'inbound_test'; address: string; token: string }
  // Сигнал дежурным о состоянии портала (ТЗ 13.8): готовый текст с числами, без данных клиентов.
  | { template: 'ops_alert'; text: string; url: string }
  // Идея: заголовки на языках портала, письмо берёт заголовок на языке получателя (иначе оригинал). ideaId: ключ
  // правила "одно письмо в сутки по идее". Причин, комментариев и имён в письме нет.
  | { template: 'idea_status'; event: IdeaMailEvent; ideaId: string; number: number; title: string; titles: Partial<Record<Locale, string>>; url: string; into?: number }
  | { template: 'staff_idea_moderation'; count: number; url: string }
  | { template: 'staff_idea_cycle'; count: number; url: string }
  | { template: 'staff_idea_dev_task_closed'; ref: string; number: number; title: string; url: string }
  // Ответ Теза (UX-B-10): вступление по идентификатору, заголовок и шаги опубликованного решения, ссылки с подписью
  // получателя. Ни одного слова модели. callback*: данные кнопок Telegram с той же подписью.
  | ({
      template: 'tez_answer';
      introId: string;
      solutionTitle: string;
      lines: string[];
      solutionUrl: string;
      helpedUrl?: string;
      staffUrl?: string;
      helpedData?: string;
      staffData?: string;
    } & TicketRef)
  | ({ template: 'tez_ack'; dueOn: string | null; startOn: string | null; timeZone: string } & TicketRef);

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

/** Тема письма по идее: [I-204] <заголовок>, без ссылок и переводов строк, не длиннее 120 знаков. */
export function ideaSubject(number: number, title: string): string {
  const chars = Array.from(noLinks(title, Number.MAX_SAFE_INTEGER));
  return `[I-${number}] ${chars.length > SUBJECT_TITLE_MAX ? `${chars.slice(0, SUBJECT_TITLE_MAX - 3).join('')}...` : chars.join('')}`;
}

/** Вступления Теза: тот же закрытый список, что INTRO_TEMPLATE_IDS модуля hda. */
const INTRO_KEYS = ['likely_solution', 'exact_error', 'similar_case', 'known_steps'] as const;

const translatorOf = (locale: Locale) => createTranslator({ locale, messages: MESSAGES[locale], namespace: 'mail' });

/** Строка "Ответьте на это письмо" на всех языках: по ней разбор входящего письма отрезает цитату (задача 7). */
export const REPLY_MARKERS: readonly string[] = (['ru', 'uz', 'en'] as const).map((locale) => MESSAGES[locale].mail.layout.replyAbove);

type Body = {
  subject: string;
  heading: string | null;
  text: string;
  html?: string;
  button: { label: string; url: string } | null;
  reply: boolean;
  signature: boolean;
  /** Строка с пятью ссылками оценки под текстом письма. */
  rating?: { label: string; url: string };
};

function body(payload: MailPayload, t: ReturnType<typeof translatorOf>, locale: Locale): Body {
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
        ...(payload.status === 'closed' && payload.mergedInto === undefined && payload.rateUrl ? { rating: { label: t('ticketStatus.rate'), url: payload.rateUrl } } : {}),
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
    case 'staff_dev_task_closed':
      return {
        subject: ticketSubject(payload.number, payload.title),
        heading: t('staffDevTaskClosed.heading'),
        text: t('staffDevTaskClosed.text', { ref: noLinks(payload.ref, NAME_MAX), number: payload.number, title: noLinks(payload.title, TITLE_MAX) }),
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
        // Темы обращения в письме дежурным нет: это текст клиента, в служебной почте он не нужен (решение 0041).
        text: t('oncallP1.text', { orgName: noLinks(payload.orgName, NAME_MAX), number: payload.number }),
        button: { label: t('oncallP1.button'), url: payload.url },
        reply: false,
        signature: false,
      };
    case 'staff_rule':
      return {
        subject: ticketSubject(payload.number, payload.title),
        heading: t('staffRule.heading'),
        text: t('staffRule.text', { rule: noLinks(payload.rule, TITLE_MAX), number: payload.number, title: noLinks(payload.title, TITLE_MAX) }),
        button: open(payload.url),
        reply: false,
        signature: false,
      };
    case 'oncall_rule':
      return {
        subject: ticketSubject(payload.number, t('oncallRule.subject')),
        heading: t('oncallRule.subject'),
        text: t('oncallRule.text', { rule: noLinks(payload.rule, TITLE_MAX), number: payload.number }),
        button: { label: t('oncallRule.button'), url: payload.url },
        reply: false,
        signature: false,
      };
    case 'staff_csat_low':
      return {
        subject: ticketSubject(payload.number, payload.title),
        heading: t('staffCsatLow.heading'),
        text: t('staffCsatLow.text', { score: payload.score, orgName: noLinks(payload.orgName, NAME_MAX), number: payload.number, title: noLinks(payload.title, TITLE_MAX) }),
        button: open(payload.url),
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
    case 'idea_status': {
      const title = noLinks(payload.titles[locale] ?? payload.title, TITLE_MAX);
      return {
        subject: ideaSubject(payload.number, payload.titles[locale] ?? payload.title),
        heading: t('ideaStatus.heading', { ref: `I-${payload.number}` }),
        text: t(`ideaStatus.${payload.event}`, { ref: `I-${payload.number}`, title, into: payload.into ? `I-${payload.into}` : '' }),
        button: { label: t('ideaStatus.button'), url: payload.url },
        reply: false,
        signature: false,
      };
    }
    case 'tez_answer': {
      const lines = payload.lines.map((line) => noLinks(line, 500)).filter(Boolean);
      const introKey = (INTRO_KEYS as readonly string[]).includes(payload.introId) ? (payload.introId as (typeof INTRO_KEYS)[number]) : 'likely_solution';
      const intro = t(`tezAnswer.intro.${introKey}`);
      const links = [payload.helpedUrl ? `${t('tezAnswer.helped')}: ${payload.helpedUrl}` : null, payload.staffUrl ? `${t('tezAnswer.needStaff')}: ${payload.staffUrl}` : null].filter(Boolean);
      const text = [t('tezAnswer.signature'), intro, noLinks(payload.solutionTitle, TITLE_MAX), lines.map((line, i) => `${i + 1}. ${line}`).join('\n'), `${t('tezAnswer.open')}: ${payload.solutionUrl}`, links.join('\n'), t('tezAnswer.caption')]
        .filter(Boolean)
        .join('\n\n');
      const html = [
        `<p style="${PARAGRAPH}"><strong>${esc(t('tezAnswer.signature'))}</strong></p>`,
        `<p style="${PARAGRAPH}">${esc(intro)}</p>`,
        `<p style="${PARAGRAPH}"><strong>${esc(noLinks(payload.solutionTitle, TITLE_MAX))}</strong></p>`,
        `<ol style="${PARAGRAPH}">${lines.map((line) => `<li>${esc(line)}</li>`).join('')}</ol>`,
        `<p style="${PARAGRAPH}">${link(payload.solutionUrl, t('tezAnswer.open'), LINK_COLOR)}</p>`,
        payload.helpedUrl && payload.staffUrl
          ? `<p style="${PARAGRAPH}">${link(payload.helpedUrl, t('tezAnswer.helped'), LINK_COLOR)} &nbsp; ${link(payload.staffUrl, t('tezAnswer.needStaff'), LINK_COLOR)}</p>`
          : '',
        `<p style="${PARAGRAPH}">${esc(t('tezAnswer.caption'))}</p>`,
      ].join('');
      return { subject: ticketSubject(payload.number, payload.title), heading: t('tezAnswer.heading', { number: payload.number }), text, html, button: open(payload.url), reply: false, signature: true };
    }
    case 'tez_ack': {
      const tz = payload.timeZone;
      const fmt = (iso: string, opts: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat(locale, { timeZone: tz, ...opts }).format(new Date(iso));
      const due = payload.startOn
        ? t('tezAck.dueStart', { day: fmt(payload.startOn, { weekday: 'long' }), time: fmt(payload.startOn, { hour: '2-digit', minute: '2-digit' }) })
        : payload.dueOn
          ? t('tezAck.due', { when: fmt(payload.dueOn, { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' }) })
          : '';
      return {
        subject: ticketSubject(payload.number, payload.title),
        heading: t('tezAck.heading', { number: payload.number }),
        text: [t('tezAck.text'), due].filter(Boolean).join('\n\n'),
        button: open(payload.url),
        reply: true,
        signature: false,
      };
    }
    case 'staff_idea_moderation':
      return {
        subject: t('staffIdeaModeration.subject', { count: payload.count }),
        heading: t('staffIdeaModeration.subject', { count: payload.count }),
        text: t('staffIdeaModeration.text', { count: payload.count }),
        button: open(payload.url),
        reply: false,
        signature: false,
      };
    case 'staff_idea_cycle':
      return {
        subject: t('staffIdeaCycle.subject'),
        heading: t('staffIdeaCycle.subject'),
        text: t('staffIdeaCycle.text', { count: payload.count }),
        button: open(payload.url),
        reply: false,
        signature: false,
      };
    case 'staff_idea_dev_task_closed':
      return {
        subject: ideaSubject(payload.number, payload.title),
        heading: t('staffDevTaskClosed.heading'),
        text: t('staffIdeaDevTaskClosed.text', { ref: noLinks(payload.ref, NAME_MAX), idea: `I-${payload.number}`, title: noLinks(payload.title, TITLE_MAX) }),
        button: open(payload.url),
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
  const b = body(data, t, locale);
  const layoutText = {
    replyAbove: t('layout.replyAbove'),
    signature: t('layout.signature'),
    support: data.supportAddress ? t('layout.support', { address: data.supportAddress }) : null,
    settings: t('layout.settings'),
    contacts: t('layout.contacts'),
  };
  const shared = { hubUrl: data.hubUrl, heading: b.heading, button: b.button, replyHint: b.reply, signature: b.signature, settingsUrl: data.settingsUrl ?? null, text: layoutText };
  const textHtml = b.html ?? b.text.split('\n\n').map((paragraph) => `<p style="${PARAGRAPH}">${esc(paragraph)}</p>`).join('');
  // Пять ссылок с оценками. Переход по ссылке оценку не ставит: её ставит кнопка на открывшейся странице.
  const scores = b.rating ? [1, 2, 3, 4, 5].map((score) => ({ score, url: `${b.rating?.url}&score=${score}` })) : [];
  const ratingHtml = b.rating ? `<p style="${PARAGRAPH}">${esc(b.rating.label)} ${scores.map(({ score, url }) => link(url, String(score), LINK_COLOR)).join(' &nbsp; ')}</p>` : '';
  const ratingText = b.rating ? `\n\n${b.rating.label}\n${scores.map(({ score, url }) => `${score}: ${url}`).join('\n')}` : '';
  return {
    subject: b.subject,
    html: renderLayout({ ...shared, lang: locale, title: b.subject, bodyHtml: textHtml + ratingHtml }),
    text: renderLayoutText({ ...shared, bodyText: b.text + ratingText }),
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
