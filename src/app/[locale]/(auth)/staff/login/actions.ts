'use server';

import { redirect } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { type HduErrorCode, nextRequest, safeReturnPath, signInStaff, verifyStaffCode } from '@/modules/hdu/api';
import { BOT_TOKEN_FIELD } from '@/ui/components/BotCheckField';

/** Состояние формы входа сотрудника. Текст ошибки приходит с сервера уже на языке страницы. */
export type StaffLoginState = {
  step: 'credentials' | 'code' | 'enroll';
  error?: string;
  /** Ключ для приложения с кодами и рисунок QR: только на шаге подключения второго фактора. */
  secret?: string;
  qr?: boolean[][];
};

// Коды ошибок, для которых есть свой текст. Остальные показываются общим сообщением.
const KNOWN_ERRORS = new Set<HduErrorCode>([
  'invalid_credentials',
  'rate_limited',
  'code_invalid',
  'code_locked',
  'sign_in_expired',
  'invalid_input',
  'bot_check',
]);

async function errorText(code: HduErrorCode, retryAfterSec?: number): Promise<string> {
  const t = await getTranslations('auth.staff.login.errors');
  if (!KNOWN_ERRORS.has(code)) return t('generic');
  return t(code, { minutes: Math.max(1, Math.ceil((retryAfterSec ?? 0) / 60)) });
}

/**
 * Вход сотрудника: шаг "адрес и пароль", затем шаг "код". Какой шаг отправлен, говорит поле формы step.
 * Права и личность определяет только сервер по кукам: состояние формы от браузера ни на что не влияет.
 */
export async function staffLoginAction(_previous: StaffLoginState, formData: FormData): Promise<StaffLoginState> {
  const request = await nextRequest();

  if (formData.get('step') === 'credentials') {
    const result = await signInStaff(
      { email: formData.get('email'), password: formData.get('password'), botToken: formData.get(BOT_TOKEN_FIELD) },
      request,
    );
    if (result.step === 'error')
      return { step: 'credentials', error: await errorText(result.code, result.retryAfterSec) };
    if (result.step === 'enroll') return { step: 'enroll', secret: result.secret, qr: result.qr };
    return { step: 'code' };
  }

  const shown = formData.get('step') === 'enroll' ? 'enroll' : 'code';
  const result = await verifyStaffCode({ code: formData.get('code') }, request);
  if (result.ok) {
    const locale = await getLocale();
    redirect(safeReturnPath(formData.get('next'), `/${locale}/agent`));
  }
  // Шаг пароля устарел: вход начинается заново.
  if (result.code === 'sign_in_expired') return { step: 'credentials', error: await errorText(result.code) };
  return { step: shown, error: await errorText(result.code) };
}
