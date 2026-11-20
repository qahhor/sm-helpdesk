import 'server-only';
import { z } from 'zod';
import { getEnv } from '@/env';
import { LOCALES } from '@/i18n/locales';
import { RATE_RULES } from '@/modules/hdc/pref';
import { consumeRateLimit, rateKey } from '@/modules/hdc/rate-limit';
import { confirmEmailMail, queueMail } from '@/modules/hdn/api';
import { confirmEmailToken, createEmailToken, markOnboarded } from '../core/email';
import { emailInput, tokenInput } from '../input';
import { hashToken } from '../tokens';
import type { ClientContext } from './orgs';

// Подтверждение адреса email и шаг первого входа (FR-ID-07, решение 0016).

const confirmationInput = z.object({ email: emailInput, locale: z.enum(LOCALES) });

/**
 * Письмо со ссылкой подтверждения адреса. Только для вошедшего клиента: адрес привязывается к нему самому.
 * 5 запросов в час на пользователя. Ответ не ждёт отправки письма.
 */
export async function requestEmailConfirmation(
  ctx: ClientContext,
  input: unknown,
): Promise<{ ok: true } | { ok: false; code: 'invalid_input' | 'rate_limited' }> {
  const parsed = confirmationInput.safeParse(input);
  if (!parsed.success) return { ok: false, code: 'invalid_input' };
  const limit = await consumeRateLimit(rateKey('email-confirm:user', ctx.user.id), RATE_RULES.emailConfirmPerUser);
  if (!limit.allowed) return { ok: false, code: 'rate_limited' };
  const { email, locale } = parsed.data;
  const token = await createEmailToken(ctx.actor, email);
  const url = new URL(`/${locale}/confirm-email`, getEnv().HUB_URL);
  url.searchParams.set('token', token);
  queueMail({ to: email, kind: 'confirm-email', ...confirmEmailMail(locale, url.toString()) });
  return { ok: true };
}

/** Подтверждение адреса по ссылке из письма. Вход не нужен: ссылку могут открыть на другом устройстве. */
export async function confirmEmail(input: unknown): Promise<{ ok: true } | { ok: false; code: 'link_invalid' | 'email_taken' }> {
  const parsed = z.object({ token: tokenInput }).safeParse(input);
  if (!parsed.success) return { ok: false, code: 'link_invalid' };
  const result = await confirmEmailToken(hashToken(parsed.data.token));
  return result === 'ok' ? { ok: true } : { ok: false, code: result };
}

/** Шаг первого входа пройден: отправлена ссылка или человек нажал "Пропустить". */
export async function completeWelcome(userId: string): Promise<void> {
  await markOnboarded(userId);
}
