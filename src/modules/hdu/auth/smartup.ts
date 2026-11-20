import 'server-only';
import { provisionFromSmartup, resolveSmartupUser } from '../core/provision';
import type { ProvisionSmartupUser, ResolveSmartupUser } from './options';

// Вход через сервер Smartup: две функции, которые библиотека входа вызывает на каждом входе.

/** Какой пользователь портала входит: по паре "сервер и sub", никогда по email. */
export const resolveUserForLibrary: ResolveSmartupUser = async (input, context) => {
  if (input.protocol !== 'oidc') return { action: 'reject', code: 'unsupported_protocol' };
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
