import { createTranslator } from 'next-intl';
import type { Locale } from '@/i18n/locales';
import { textToHtml } from './mail/html';
import { LINK_COLOR, PARAGRAPH } from './mail/layout';
import { wrapPlainMail } from './mail/render';
import { noLinks, personName as personNameOf } from './mail/sanitize';
import en from '../../../messages/en.json';
import ru from '../../../messages/ru.json';
import uz from '../../../messages/uz.json';

// Модуль hdn, тексты писем. Сами тексты лежат в messages/*.json, пространство mail:
// письма переводятся так же, как интерфейс, и проходят те же проверки слов.

const MESSAGES = { ru, uz, en } as const;

/** Сколько живёт ссылка для входа, минут: совпадает с LOGIN_LINK_TTL_SEC модуля hdu (проверяет тест). */
export const LOGIN_LINK_MINUTES = 15;
/** Сколько живёт ссылка подтверждения адреса, минут. */
export const CONFIRM_EMAIL_MINUTES = 60;
/** Сколько живёт приглашение, дней (FR-ID-08). */
export const INVITATION_DAYS = 7;
/** Сколько живёт приглашение сотрудника и ссылка после сброса, часов (решение 0015). */
export const STAFF_LINK_HOURS = 24;

export type MailText = { subject: string; text: string; html: string };

const mailOf = (locale: Locale) => createTranslator({ locale, messages: MESSAGES[locale], namespace: 'mail' });

/** Предел длины имени человека и названия организации в письме, знаков. */
const NAME_MAX = 60;
const ORG_NAME_MAX = 100;
/** Имя пользователя Telegram: латиница, цифры и подчёркивание, от 5 до 32 знаков. */
const TELEGRAM_USERNAME = /^@[A-Za-z0-9_]{5,32}$/;

const personName = (value: string, fallback: string) => personNameOf(value, NAME_MAX, fallback);
const orgTitle = (value: string) => noLinks(value, ORG_NAME_MAX);

/**
 * Письмо M1 с HTML в общей оболочке писем вехи M4 (решение 4): текст прежний, ссылка в нём становится ссылкой.
 * Адрес портала для логотипа берётся из ссылки письма: она всегда ведёт на портал.
 */
function withHtml(locale: Locale, url: string, mail: { subject: string; text: string }): MailText {
  const bodyHtml = textToHtml(mail.text, { paragraph: PARAGRAPH, linkColor: LINK_COLOR });
  return { ...mail, html: wrapPlainMail(locale, { ...mail, bodyHtml, hubUrl: new URL(url).origin }) };
}

/** Письмо со ссылкой для входа. */
export function loginLinkMail(locale: Locale, url: string): MailText {
  const t = mailOf(locale);
  return withHtml(locale, url, { subject: t('loginLink.subject'), text: t('loginLink.text', { url, minutes: LOGIN_LINK_MINUTES }) });
}

/** Письмо со ссылкой подтверждения адреса. */
export function confirmEmailMail(locale: Locale, url: string): MailText {
  const t = mailOf(locale);
  return withHtml(locale, url, { subject: t('confirmEmail.subject'), text: t('confirmEmail.text', { url, minutes: CONFIRM_EMAIL_MINUTES }) });
}

/**
 * Приглашение в организацию клиента. Имени в теме нет: тема видна до открытия письма и не должна
 * говорить словами постороннего. Название организации задаёт сервер Smartup или сотрудник портала.
 */
export function invitationMail(locale: Locale, input: { url: string; orgName: string; inviterName: string }): MailText {
  const t = mailOf(locale);
  const inviterName = personName(input.inviterName, t('invitation.inviterFallback'));
  return withHtml(locale, input.url, {
    subject: t('invitation.subject'),
    text: t('invitation.text', { url: input.url, orgName: orgTitle(input.orgName), inviterName, days: INVITATION_DAYS }),
  });
}

/** Письмо о новой привязке Telegram (угроза T30): если привязал не человек, он отвяжет аккаунт в профиле. */
export function telegramLinkedMail(locale: Locale, input: { account: string; url: string }): MailText {
  const t = mailOf(locale);
  // Имя в Telegram задаёт кто угодно: без ссылок и управляющих знаков, как имя в приглашении (итоговая проверка доработки).
  const account = TELEGRAM_USERNAME.test(input.account) ? input.account : personName(input.account, t('telegramLinked.accountFallback'));
  return withHtml(locale, input.url, { subject: t('telegramLinked.subject'), text: t('telegramLinked.text', { url: input.url, account }) });
}

/** Приглашение сотрудника в рабочее место (FR-ADM-03): пароль и второй фактор человек задаёт сам по ссылке. */
export function staffInvitationMail(locale: Locale, input: { url: string; inviterName: string }): MailText {
  const t = mailOf(locale);
  const inviterName = personName(input.inviterName, t('staffInvitation.inviterFallback'));
  return withHtml(locale, input.url, {
    subject: t('staffInvitation.subject'),
    text: t('staffInvitation.text', { url: input.url, inviterName, hours: STAFF_LINK_HOURS }),
  });
}

/** Ссылка после сброса пароля и второго фактора: все сессии сотрудника уже завершены. */
export function staffResetMail(locale: Locale, input: { url: string }): MailText {
  const t = mailOf(locale);
  return withHtml(locale, input.url, { subject: t('staffReset.subject'), text: t('staffReset.text', { ...input, hours: STAFF_LINK_HOURS }) });
}
