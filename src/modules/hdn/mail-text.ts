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

/** Приглашение в организацию клиента. */
export function invitationMail(locale: Locale, input: { url: string; orgName: string; inviterName: string }): MailText {
  const t = mailOf(locale);
  return {
    subject: t('invitation.subject', { inviterName: input.inviterName }),
    text: t('invitation.text', { ...input, days: INVITATION_DAYS }),
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
  return {
    subject: t('staffInvitation.subject', { inviterName: input.inviterName }),
    text: t('staffInvitation.text', { ...input, hours: STAFF_LINK_HOURS }),
  };
}

/** Ссылка после сброса пароля и второго фактора: все сессии сотрудника уже завершены. */
export function staffResetMail(locale: Locale, input: { url: string }): MailText {
  const t = mailOf(locale);
  return { subject: t('staffReset.subject'), text: t('staffReset.text', { ...input, hours: STAFF_LINK_HOURS }) };
}
