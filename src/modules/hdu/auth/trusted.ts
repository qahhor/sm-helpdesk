import 'server-only';
import { APIError, createAuthEndpoint } from 'better-auth/api';
import { setSessionCookie } from 'better-auth/cookies';
import * as z from 'zod';
import { TRUSTED_SIGN_IN_WAYS } from '../pref';

// Свой способ входа библиотеки: сессия для пользователя, которого портал уже проверил сам
// одноразовой ссылкой (приглашение, ссылка из бота Telegram). Решение 0012, пункт 6.
//
// Точка входа закрытая (SERVER_ONLY): снаружи адрес отвечает 404, вызвать её можно только как функцию
// auth.api.signInTrusted(...). Вызывает её одна функция портала, createTrustedSession.
// Сотрудникам этот путь закрыт перехватчиком создания сессии (hooks.ts): ctx.path равен /sign-in/trusted.

const body = z.object({ userId: z.uuid(), via: z.enum(TRUSTED_SIGN_IN_WAYS) });

export const hubTrusted = () => ({
  id: 'hub-trusted' as const,
  endpoints: {
    signInTrusted: createAuthEndpoint(
      '/sign-in/trusted',
      { method: 'POST', body, metadata: { SERVER_ONLY: true } },
      async (ctx) => {
        const user = await ctx.context.internalAdapter.findUserById(ctx.body.userId);
        if (!user) throw new APIError('NOT_FOUND', { code: 'USER_NOT_FOUND', message: 'User not found' });
        const session = await ctx.context.internalAdapter.createSession(user.id);
        if (!session)
          throw new APIError('FORBIDDEN', { code: 'FAILED_TO_CREATE_SESSION', message: 'Failed to create session' });
        await setSessionCookie(ctx, { session, user });
        return ctx.json({ token: session.token, userId: user.id, via: ctx.body.via });
      },
    ),
  },
});
