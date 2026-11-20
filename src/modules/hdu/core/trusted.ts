import 'server-only';
import { getAuth } from '../auth/instance';
import type { RequestInfo } from '../api/request';
import type { TrustedSignInWay } from '../pref';

/**
 * Выдаёт сессию пользователю, которого портал только что проверил сам одноразовой ссылкой
 * (приглашение, ссылка из бота). Вызывать только после такой проверки. Сотруднику сессию не выдаст:
 * это отклоняет перехватчик библиотеки входа (решение 0012, пункт 6).
 */
export async function createTrustedSession(userId: string, via: TrustedSignInWay, request: RequestInfo): Promise<void> {
  const auth = await getAuth();
  const result = await auth.api.signInTrusted({ body: { userId, via }, headers: request.headers, returnHeaders: true });
  request.setCookies(result.headers);
}
