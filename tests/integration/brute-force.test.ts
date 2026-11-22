import { randomBytes } from 'node:crypto';
import { expect, test } from 'vitest';
import { RATE_RULES } from '@/modules/hdc/pref';
import { completeLoginLink } from '@/modules/hdu/api/login-link';
import { acceptInvitation } from '@/modules/hdu/api/invitations';
import { confirmEmail } from '@/modules/hdu/api/email';
import { acceptStaffInvitation, signInStaff } from '@/modules/hdu/api/staff';
import { completeTelegramLogin } from '@/modules/hdu/api/telegram';
import { newJar } from './helpers/auth';

// Защита от перебора (ТЗ 14.5, V6 ASVS): пределы с одного адреса посетителя поверх пределов на учётную запись
// и проверки "не робот". Адрес приходит заголовком доверенного прокси; локально это x-forwarded-for.

const from = (ip: string) => newJar({ 'x-forwarded-for': ip }).request;
const randomToken = () => randomBytes(24).toString('base64url');

test('вход сотрудника: с одного адреса не больше 100 попыток за 15 минут по любым учётным записям', async () => {
  expect(RATE_RULES.staffLoginPerIp).toEqual({ limit: 100, windowSec: 900 });
  const attacker = from('203.0.113.50');
  // Подбор паролей по разным адресам: предел на учётную запись (10) не срабатывает, срабатывает предел на адрес.
  for (let i = 0; i < 100; i++)
    expect(await signInStaff({ email: `victim-${i}@smartup.example`, password: 'Winter2026!' }, attacker)).toEqual({ step: 'error', code: 'invalid_credentials' });
  expect(await signInStaff({ email: 'victim-101@smartup.example', password: 'Winter2026!' }, attacker)).toEqual({
    step: 'error',
    code: 'rate_limited',
    retryAfterSec: 900,
  });
  // Другой адрес не задет.
  expect(await signInStaff({ email: 'victim-101@smartup.example', password: 'Winter2026!' }, from('198.51.100.9'))).toEqual({
    step: 'error',
    code: 'invalid_credentials',
  });
});

test('одноразовые ссылки и токены: с одного адреса не больше 30 попыток за 10 минут, счётчик общий для всех видов', async () => {
  expect(RATE_RULES.tokenRedeemPerIp).toEqual({ limit: 30, windowSec: 600 });
  const attacker = from('203.0.113.60');
  for (let i = 0; i < 10; i++) expect(await completeLoginLink({ token: randomToken(), locale: 'ru' }, attacker)).toEqual({ ok: false, code: 'link_invalid' });
  for (let i = 0; i < 10; i++) expect(await completeTelegramLogin({ token: randomToken(), locale: 'ru' }, attacker)).toEqual({ ok: false, code: 'link_invalid' });
  for (let i = 0; i < 10; i++) expect(await acceptInvitation({ token: randomToken(), name: 'Бот' }, attacker)).toEqual({ ok: false, code: 'link_invalid' });
  // 31-я попытка любого вида отклоняется, даже с верным по виду токеном.
  expect(await completeLoginLink({ token: randomToken(), locale: 'ru' }, attacker)).toEqual({ ok: false, code: 'rate_limited' });
  expect(await completeTelegramLogin({ token: randomToken(), locale: 'ru' }, attacker)).toEqual({ ok: false, code: 'rate_limited' });
  expect(await acceptInvitation({ token: randomToken(), name: 'Бот' }, attacker)).toEqual({ ok: false, code: 'rate_limited' });
  expect(await confirmEmail({ token: randomToken() }, null, '203.0.113.60')).toEqual({ ok: false, code: 'rate_limited' });
  await expect(acceptStaffInvitation({ token: randomToken(), name: 'Бот', password: 'correct-horse-12' }, attacker)).rejects.toMatchObject({ code: 'rate_limited' });
  // Другой адрес не задет.
  expect(await completeLoginLink({ token: randomToken(), locale: 'ru' }, from('198.51.100.10'))).toEqual({ ok: false, code: 'link_invalid' });
});
