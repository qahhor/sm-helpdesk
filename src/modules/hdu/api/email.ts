import 'server-only';
import { redeemAllowed } from './redeem-limit';
import { z } from 'zod';
import { getEnv } from '@/env';
import { LOCALES } from '@/i18n/locales';
import { consumeRateLimit, rateKey } from '@/modules/hdc/api';
import { POLICY_VERSION_PATTERN } from '@/modules/hdc/pref';
import { RATE_RULES } from '@/modules/hdc/pref';
import { confirmEmailMail, queueMail } from '@/modules/hdn/api';
import { confirmEmailToken, createEmailToken, hintsPendingFor, markHintsSeen, markOnboarded, setPolicyVersion } from '../core/email';
import { HduError } from '../error';
import { emailInput, tokenInput } from '../input';
import { hashToken } from '../tokens';
import type { ClientContext } from './orgs';
import { isRecentSignIn } from './session';
import type { SessionData } from './request';

// Подтверждение адреса email и шаг первого входа (FR-ID-07, решение 0016).

const confirmationInput = z.object({ email: emailInput, locale: z.enum(LOCALES) });

/**
 * Письмо со ссылкой подтверждения адреса. Только для вошедшего клиента: адрес привязывается к нему самому.
 * Адресом потом входят по ссылке, поэтому нужен вход не старше 15 минут, как у настроек сотрудников
 * (ASVS 7.5.1; ответ владельца 26.11.2026, решение 0067): иначе stale_session, страница просит войти заново.
 * 5 запросов в час на пользователя. Ответ не ждёт отправки письма.
 */
export async function requestEmailConfirmation(
  ctx: ClientContext,
  input: unknown,
): Promise<{ ok: true } | { ok: false; code: 'invalid_input' | 'rate_limited' | 'stale_session' }> {
  const parsed = confirmationInput.safeParse(input);
  if (!parsed.success) return { ok: false, code: 'invalid_input' };
  if (!isRecentSignIn(ctx.sessionCreatedAt, new Date())) return { ok: false, code: 'stale_session' };
  const limit = await consumeRateLimit(rateKey('email-confirm:user', ctx.user.id), RATE_RULES.emailConfirmPerUser);
  if (!limit.allowed) return { ok: false, code: 'rate_limited' };
  const { email, locale } = parsed.data;
  const token = await createEmailToken(ctx.actor, email);
  const url = new URL(`/${locale}/confirm-email`, getEnv().HUB_URL);
  url.searchParams.set('token', token);
  queueMail({ to: email, kind: 'confirm-email', ...confirmEmailMail(locale, url.toString()) });
  return { ok: true };
}

/**
 * Подтверждение адреса по ссылке из письма. Подтверждает только вошедший пользователь, который запросил
 * ссылку (проверка main, S2): открыли ссылку без входа, ответ sign_in_required, в другой учётной записи
 * wrong_account. Ссылка при этом не тратится.
 */
export async function confirmEmail(
  input: unknown,
  session: SessionData | null,
  ip?: string | null,
): Promise<{ ok: true } | { ok: false; code: 'link_invalid' | 'email_taken' | 'sign_in_required' | 'wrong_account' | 'rate_limited' }> {
  if (!(await redeemAllowed(ip ?? null)).ok) return { ok: false, code: 'rate_limited' };
  const parsed = z.object({ token: tokenInput }).safeParse(input);
  if (!parsed.success) return { ok: false, code: 'link_invalid' };
  if (!session) return { ok: false, code: 'sign_in_required' };
  const result = await confirmEmailToken(hashToken(parsed.data.token), session.user.id, ip);
  return result === 'ok' ? { ok: true } : { ok: false, code: result };
}

/** Шаг первого входа пройден: отправлена ссылка или человек нажал "Пропустить". */
export async function completeWelcome(userId: string): Promise<void> {
  await markOnboarded(userId);
}

/**
 * Пользователь увидел политику обработки данных этой версии (раздел 14.6 ТЗ). Шаг первого входа
 * покажет строку о политике снова, только когда выйдет новая версия.
 */
export async function acknowledgePolicy(userId: string, version: string, ip?: string | null): Promise<void> {
  if (!POLICY_VERSION_PATTERN.test(version)) throw new HduError('invalid_input');
  await setPolicyVersion(userId, version, ip);
}

/** Подсказки первого входа над главной (UX-C-14). Пользователь берётся из контекста клиента, не из запроса. */
export function hintsPending(ctx: ClientContext): Promise<boolean> {
  return hintsPendingFor(ctx.actor.userId);
}

/** Кнопка "Понятно": подсказки больше не показываются. */
export function dismissHints(ctx: ClientContext): Promise<void> {
  return markHintsSeen(ctx.actor.userId);
}
