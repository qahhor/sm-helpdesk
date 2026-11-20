// Модуль hdu, слой util: чистые функции без обращения к базе (docs/naming.md, раздел 5).
import { SERVER_CODE_PATTERN } from './pref';

const SSO_CALLBACK = /^\/api\/auth\/sso\/callback\/([^/]+)$/;

/**
 * Какие запросы к библиотеке входа открыты снаружи. Только возврат с сервера Smartup:
 * /api/auth/sso/callback/<код сервера>. Остальные адреса библиотеки (их 54) портал снаружи не отдаёт:
 * вход, сессии и ссылки вызываются серверными действиями как функции (решение 0012).
 */
export function isAllowedAuthRequest(method: string, pathname: string): boolean {
  if (method !== 'GET' && method !== 'POST') return false;
  const code = SSO_CALLBACK.exec(pathname)?.[1];
  return code !== undefined && SERVER_CODE_PATTERN.test(code);
}
