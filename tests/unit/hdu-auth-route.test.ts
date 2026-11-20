import { expect, test } from 'vitest';
import { isAllowedAuthRequest } from '@/modules/hdu/util';

test('наружу открыт только возврат с сервера Smartup', () => {
  expect(isAllowedAuthRequest('GET', '/api/auth/sso/callback/cloud')).toBe(true);
  expect(isAllowedAuthRequest('POST', '/api/auth/sso/callback/srv-acme')).toBe(true);
  for (const [method, path] of [
    ['GET', '/api/auth/get-session'],
    ['POST', '/api/auth/sign-in/email'],
    ['POST', '/api/auth/sign-up/email'],
    ['POST', '/api/auth/sign-in/magic-link'],
    ['GET', '/api/auth/magic-link/verify'],
    ['POST', '/api/auth/sign-in/trusted'],
    ['POST', '/api/auth/change-email'],
    ['POST', '/api/auth/two-factor/verify-totp'],
    ['POST', '/api/auth/sso/register'],
    ['GET', '/api/auth/sso/providers'],
    ['GET', '/api/auth/sso/callback'],
    ['GET', '/api/auth/sso/callback/'],
    ['POST', '/api/auth/sso/saml2/sp/acs/cloud'],
    ['GET', '/api/auth/sso/callback/cloud/extra'],
    ['GET', '/api/auth/sso/callback/..%2Fget-session'],
    ['GET', '/api/auth/sso/callback/Cloud'],
    ['GET', '/api/auth/sso/callback/' + 'a'.repeat(40)],
    ['GET', '/API/auth/sso/callback/cloud'],
    ['PUT', '/api/auth/sso/callback/cloud'],
    ['DELETE', '/api/auth/sso/callback/cloud'],
    ['HEAD', '/api/auth/sso/callback/cloud'],
  ] as const)
    expect(isAllowedAuthRequest(method, path), `${method} ${path}`).toBe(false);
});
