import { createTranslator } from 'next-intl';
import type { Locale } from '@/i18n/locales';
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

export type MailText = { subject: string; text: string };

const mailOf = (locale: Locale) => createTranslator({ locale, messages: MESSAGES[locale], namespace: 'mail' });

/** Предел длины имени человека и названия организации в письме, знаков. */
const NAME_MAX = 60;
const ORG_NAME_MAX = 100;
/** Похоже на ссылку или адрес: схема, www., домен, email. */
const LINK_LIKE = /[a-z][a-z0-9+.-]*:\/\/|www\.|[\p{L}\p{N}-]+\.\p{L}{2,}|@/iu;

/** Без управляющих знаков и знаков направления текста, пробелы схлопнуты, длина не больше предела. */
function plain(value: string, max: number): string {
  const text = value.replace(/\p{Cf}/gu, '').replace(/\p{Cc}/gu, ' ').replace(/\s+/gu, ' ').trim();
  const chars = Array.from(text);
  return chars.length > max ? `${chars.slice(0, max).join('')}...` : text;
}

/**
 * Имя человека из Smartup или профиля для письма (проверка main, S8). Имя со ссылкой или адресом
 * заменяется общим словом: иначе приглашение служило бы приманкой с чужим адресом от имени портала.
 */
function personName(value: string, fallback: string): string {
  const name = plain(value, NAME_MAX);
  return name && !LINK_LIKE.test(name) ? name : fallback;
}

/** Письмо со ссылкой для входа. */
export function loginLinkMail(locale: Locale, url: string): MailText {
  const t = mailOf(locale);
  return { subject: t('loginLink.subject'), text: t('loginLink.text', { url, minutes: LOGIN_LINK_MINUTES }) };
}

/** Письмо со ссылкой подтверждения адреса. */
export function confirmEmailMail(locale: Locale, url: string): MailText {
  const t = mailOf(locale);
  return { subject: t('confirmEmail.subject'), text: t('confirmEmail.text', { url, minutes: CONFIRM_EMAIL_MINUTES }) };
}

/**
 * Приглашение в организацию клиента. Имени в теме нет: тема видна до открытия письма и не должна
 * говорить словами постороннего. Название организации задаёт сервер Smartup или сотрудник портала.
 */
export function invitationMail(locale: Locale, input: { url: string; orgName: string; inviterName: string }): MailText {
  const t = mailOf(locale);
  const inviterName = personName(input.inviterName, t('invitation.inviterFallback'));
  return {
    subject: t('invitation.subject'),
    text: t('invitation.text', { url: input.url, orgName: plain(input.orgName, ORG_NAME_MAX), inviterName, days: INVITATION_DAYS }),
  };
}

/** Письмо о новой привязке Telegram (угроза T30): если привязал не человек, он отвяжет аккаунт в профиле. */
export function telegramLinkedMail(locale: Locale, input: { account: string; url: string }): MailText {
  const t = mailOf(locale);
  return { subject: t('telegramLinked.subject'), text: t('telegramLinked.text', input) };
}

/** Приглашение сотрудника в рабочее место (FR-ADM-03): пароль и второй фактор человек задаёт сам по ссылке. */
export function staffInvitationMail(locale: Locale, input: { url: string; inviterName: string }): MailText {
  const t = mailOf(locale);
  const inviterName = personName(input.inviterName, t('staffInvitation.inviterFallback'));
  return {
    subject: t('staffInvitation.subject'),
    text: t('staffInvitation.text', { url: input.url, inviterName, hours: STAFF_LINK_HOURS }),
  };
}

/** Ссылка после сброса пароля и второго фактора: все сессии сотрудника уже завершены. */
export function staffResetMail(locale: Locale, input: { url: string }): MailText {
  const t = mailOf(locale);
  return { subject: t('staffReset.subject'), text: t('staffReset.text', { ...input, hours: STAFF_LINK_HOURS }) };
}
