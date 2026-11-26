import 'server-only';
import { provisionFromSmartup, resolveSmartupUser } from '../core/provision';
import { logEvent } from '@/lib/log';
import type { ProvisionSmartupUser, ResolveSmartupUser } from './options';
import { currentReauth, REAUTH_CLOCK_SKEW_SEC } from './reauth';

// Вход через сервер Smartup: две функции, которые библиотека входа вызывает на каждом входе.

/** Какой пользователь портала входит: по паре "сервер и sub", никогда по email. */
export const resolveUserForLibrary: ResolveSmartupUser = async (input, context) => {
  if (input.protocol !== 'oidc') return { action: 'reject', code: 'unsupported_protocol' };
  // Вход заново: сервер должен был спросить пароль. auth_time раньше начала входа значит, что он вошёл по открытой
  // сессии Smartup Web (проверка подготовки M9, I1). Без auth_time проверить нельзя: вопрос разработчикам Smartup.
  const reauth = currentReauth();
  if (reauth) {
    const authTime = input.verifiedIdTokenClaims.auth_time;
    if (typeof authTime === 'number') {
      if (authTime < reauth.startedSec - REAUTH_CLOCK_SKEW_SEC) return { action: 'reject', code: 'stale_authentication' };
    } else logEvent('warn', 'auth.reauth_unverified', { providerId: input.providerId });
  }
  const { userId } = await resolveSmartupUser(
    {
      providerId: input.providerId,
      accountId: input.accountKey.accountId,
      name: input.providerClaims.name ?? input.verifiedIdTokenClaims.name,
    },
    context.database,
  );
  // profile: 'preserve': библиотека не переписывает имя и адрес. Имя обновляет provisionFromSmartup,
  // адрес становится адресом для входа только после подтверждения ссылкой.
  return { action: 'link', userId, profile: 'preserve' };
};

/** Организация и членство после входа. Ошибок не бросает: библиотека их не перехватывает. */
export const provisionForLibrary: ProvisionSmartupUser = async ({ user, userInfo, provider }) => {
  await provisionFromSmartup(user.id, provider.providerId, userInfo);
};
