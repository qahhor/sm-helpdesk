import 'server-only';
import { hashPassword } from 'better-auth/crypto';
import { encode as encodeQr } from 'uqr';
import * as z from 'zod';
import { withIdentity } from '@/db/with-identity';
import { writeAudit } from '@/modules/hdc/audit';
import { RATE_RULES } from '@/modules/hdc/pref';
import { consumeRateLimit, rateKey, resetRateLimit } from '@/modules/hdc/rate-limit';
import { clientIp } from '@/modules/hdc/util';
import { getBotCheck } from '@/security/bot-check';
import { getAuth } from '../auth/instance';
import { revokeOtherOwnSessions, revokeSessionById } from '../core/sessions';
import { acceptStaffInvitationTx, findStaff, findStaffByEmail, findStaffInvitation } from '../core/staff';
import type { HduErrorCode } from '../error';
import { emailInput, nameInput, parseInput, passwordInput, tokenInput, totpCodeInput } from '../input';
import { hashToken } from '../tokens';
import { readSession, type RequestInfo } from './request';

// Вход сотрудника: пароль и обязательный второй фактор TOTP (FR-ID-09).
// Вход по ссылке и через Smartup сотрудникам закрыт перехватчиками библиотеки входа.

const acceptInput = z.object({ token: tokenInput, name: nameInput, password: passwordInput });
// При входе длина пароля не проверяется по правилу "не короче 12": неверный пароль просто не подойдёт.
const signInInput = z.object({ email: emailInput, password: z.string().min(1).max(128) });
const codeInput = z.object({ code: totpCodeInput });

export type StaffSignInResult =
  | { step: 'code' }
  // Второй фактор ещё не подключён: ключ для приложения с кодами и рисунок QR.
  | { step: 'enroll'; secret: string; qr: boolean[][] }
  | { step: 'error'; code: HduErrorCode; retryAfterSec?: number };

const accountKey = (email: string) => rateKey('staff-login:account', email);

/**
 * Неудачный вход сотрудника в журнал аудита с адресом (ТЗ, угроза T11; проверка main, S5). Пишется только
 * для адреса сотрудника: попытки с чужими адресами журнал не засоряют и не раскрывают, есть ли сотрудник.
 */
async function recordFailedSignIn(email: string, step: 'password' | 'rate_limited', request: Pick<RequestInfo, 'headers'>): Promise<void> {
  const staffRow = await findStaffByEmail(email);
  if (!staffRow) return;
  await withIdentity({ type: 'system', job: 'identity.staff.sign-in' }, (tx) =>
    writeAudit(tx, { action: 'staff.sign_in_failed', objectType: 'staff', objectId: staffRow.userId, diff: { step }, ip: clientIp(request.headers) }),
  );
}

/** Приглашение сотрудника по токену ссылки: чей это адрес. Пусто, если ссылка не действует. */
export async function describeStaffInvitation(token: unknown): Promise<{ email: string; name: string | null } | null> {
  const parsed = tokenInput.safeParse(token);
  return parsed.success ? findStaffInvitation(hashToken(parsed.data)) : null;
}

/** Сотрудник задаёт пароль по ссылке приглашения. После этого он входит и подключает второй фактор. */
export async function acceptStaffInvitation(input: unknown): Promise<void> {
  const data = parseInput(acceptInput, input);
  await acceptStaffInvitationTx({
    tokenHash: hashToken(data.token),
    name: data.name,
    passwordHash: await hashPassword(data.password),
  });
}

/** Заголовки запроса с куками, которые только что поставила библиотека: для следующего вызова в том же действии. */
function withNewCookies(request: RequestInfo, responseHeaders: Headers): Headers {
  const jar = new Map<string, string>();
  for (const pair of (request.headers.get('cookie') ?? '').split('; ').filter(Boolean))
    jar.set(pair.slice(0, pair.indexOf('=')), pair);
  for (const line of responseHeaders.getSetCookie()) {
    const pair = line.split(';')[0] ?? '';
    const name = pair.slice(0, pair.indexOf('='));
    if (/max-age=0/i.test(line)) jar.delete(name);
    else jar.set(name, pair);
  }
  const headers = new Headers(request.headers);
  headers.set('cookie', [...jar.values()].join('; '));
  return headers;
}

/**
 * Первый шаг входа сотрудника: адрес и пароль.
 *
 * Счётчик попыток проверяется до пароля и одинаково для любого адреса: по ответу нельзя узнать,
 * есть ли такой сотрудник. Неверный адрес и неверный пароль дают один и тот же код ошибки.
 */
export async function signInStaff(input: unknown, request: RequestInfo): Promise<StaffSignInResult> {
  const parsed = signInInput.safeParse(input);
  if (!parsed.success) return { step: 'error', code: 'invalid_credentials' };
  const { email, password } = parsed.data;

  // Проверка "не робот" до счётчика попыток и до пароля: поток роботов не блокирует учётную запись сотрудника.
  const check = getBotCheck();
  const botToken = (input as { botToken?: unknown }).botToken;
  if (check.enabled && (await check.verify(botToken, clientIp(request.headers))) === 'failed') return { step: 'error', code: 'bot_check' };

  const limit = await consumeRateLimit(accountKey(email), RATE_RULES.staffLoginPerAccount);
  if (!limit.allowed) {
    await recordFailedSignIn(email, 'rate_limited', request);
    return { step: 'error', code: 'rate_limited', retryAfterSec: limit.retryAfterSec };
  }

  const previous = await readSession(request);
  const auth = await getAuth();
  let result;
  try {
    result = await auth.api.signInEmail({ body: { email, password }, headers: request.headers, returnHeaders: true });
  } catch {
    await recordFailedSignIn(email, 'password', request);
    return { step: 'error', code: 'invalid_credentials' };
  }
  request.setCookies(result.headers);
  // Повторный вход в том же браузере: прежняя сессия больше не нужна.
  if (previous) await revokeSessionById(previous.session.id);

  if ('twoFactorRedirect' in result.response && result.response.twoFactorRedirect) return { step: 'code' };

  // Второй фактор ещё не подключён. Пароль у действия в руках, поэтому подключение начинается сразу:
  // спрашивать пароль второй раз и где-то его хранить не нужно.
  let enabled;
  try {
    enabled = await auth.api.enableTwoFactor({ body: { password }, headers: withNewCookies(request, result.headers) });
  } catch {
    return { step: 'error', code: 'invalid_credentials' };
  }
  if (enabled.method !== 'totp') return { step: 'error', code: 'invalid_credentials' };
  const secret = new URL(enabled.totpURI).searchParams.get('secret') ?? '';
  return { step: 'enroll', secret, qr: encodeQr(enabled.totpURI).data };
}

const CODE_ERRORS: Record<string, HduErrorCode> = {
  INVALID_CODE: 'code_invalid',
  ACCOUNT_TEMPORARILY_LOCKED: 'code_locked',
  TOO_MANY_ATTEMPTS_REQUEST_NEW_CODE: 'code_locked',
};

/**
 * Второй шаг входа: код из приложения. Тот же вызов завершает подключение второго фактора при первом входе.
 * Пять неверных кодов блокируют проверку на 15 минут.
 *
 * Сессия уже есть (проверка main, S1):
 * - у сотрудника второй фактор уже подключён: код этой сессии не нужен. Сессия без отметки второго фактора
 *   (открыта одним паролем до подключения в другом браузере) завершается, иначе через неё подбирали бы код:
 *   на этом пути библиотека попытки не считает;
 * - второй фактор подключается: попытки считает портал, а после подключения остальные сессии сотрудника
 *   завершаются.
 */
export async function verifyStaffCode(
  input: unknown,
  request: RequestInfo,
): Promise<{ ok: true } | { ok: false; code: HduErrorCode }> {
  const parsed = codeInput.safeParse(input);
  if (!parsed.success) return { ok: false, code: 'invalid_input' };
  const current = await readSession(request);
  if (current?.user.twoFactorEnabled) {
    if (!current.session.secondFactorAt) await revokeSessionById(current.session.id);
    return { ok: false, code: 'sign_in_expired' };
  }
  if (current) {
    const limit = await consumeRateLimit(rateKey('staff-enroll-code:user', current.user.id), RATE_RULES.staffEnrollCodePerUser);
    if (!limit.allowed) return { ok: false, code: 'code_locked' };
  }
  const auth = await getAuth();
  let result;
  try {
    result = await auth.api.verifyTOTP({ body: { code: parsed.data.code }, headers: request.headers, returnHeaders: true });
  } catch (error) {
    const libraryCode = (error as { body?: { code?: string } }).body?.code ?? '';
    // Любая другая ошибка означает, что шаг пароля не пройден или устарел: вход начинается заново.
    return { ok: false, code: CODE_ERRORS[libraryCode] ?? 'sign_in_expired' };
  }
  request.setCookies(result.headers);

  const session = await readSession({ headers: withNewCookies(request, result.headers) });
  const staff = session ? await findStaff(session.user.id) : null;
  if (!session || !staff || staff.role === 'agent_bot') return { ok: false, code: 'sign_in_expired' };
  // Второй фактор только что подключён: сессии, открытые до этого одним паролем, больше не нужны.
  if (current) await revokeOtherOwnSessions(session.user.id, session.session.id);
  await resetRateLimit(accountKey(session.user.email));
  await withIdentity({ type: 'staff', userId: session.user.id, staffRole: staff.role }, (tx) =>
    writeAudit(tx, { action: 'staff.signed_in', objectType: 'staff', objectId: session.user.id, ip: clientIp(request.headers) }),
  );
  return { ok: true };
}
