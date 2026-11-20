import 'server-only';
import { getEnv } from '@/env';
import { DEFAULT_LOCALE, isLocale } from '@/i18n/locales';
import { loginLinkMail, queueMail } from '@/modules/hdn/api';
import { safeReturnPath } from '../util';
import type { SendMagicLink } from './options';

/**
 * Письмо со ссылкой для входа. Библиотека даёт адрес своего обработчика (/api/auth/...), он снаружи закрыт:
 * в письмо идёт страница портала /{язык}/login/link с тем же токеном, вход выполняет кнопка на ней.
 */
export const sendLoginLinkMail: SendMagicLink = async (data) => {
  const metadata = (typeof data.metadata === 'object' && data.metadata !== null ? data.metadata : {}) as Record<string, unknown>;
  const locale = typeof metadata.locale === 'string' && isLocale(metadata.locale) ? metadata.locale : DEFAULT_LOCALE;
  const url = new URL(`/${locale}/login/link`, getEnv().HUB_URL);
  url.searchParams.set('token', data.token);
  url.searchParams.set('next', safeReturnPath(metadata.next, `/${locale}`));
  queueMail({ to: data.email, kind: 'login-link', ...loginLinkMail(locale, url.toString()) });
};
