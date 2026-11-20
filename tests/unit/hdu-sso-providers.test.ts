import { expect, test } from 'vitest';
import { toSsoProviders, trustedOriginsFor } from '@/modules/hdu/auth/sso-providers';

const cloud = { code: 'cloud', issuer: 'https://id.smartup.example', clientId: 'hub', clientSecret: 's', endpoints: null };

test('сервер реестра превращается в настройку библиотеки с личностью по sub', () => {
  const [provider] = toSsoProviders([cloud]);
  expect(provider?.providerId).toBe('cloud');
  expect(provider?.domain).toBe('cloud.sso.invalid');
  expect(provider?.oidcConfig).toMatchObject({
    issuer: cloud.issuer,
    clientId: 'hub',
    clientSecret: 's',
    pkce: true,
    discoveryEndpoint: 'https://id.smartup.example/.well-known/openid-configuration',
    scopes: ['openid', 'profile', 'email'],
  });
  // Email от Smartup необязателен: личность задаётся идентификатором пользователя (sub).
  expect(provider?.oidcConfig.mapping).toEqual({
    email: 'sub',
    name: 'name',
    extraFields: { companyId: 'company_id', companyName: 'company_name', inn: 'inn', role: 'role', locale: 'locale', contactEmail: 'email' },
  });
});

test('адрес сервера входа с косой чертой на конце даёт тот же адрес документа discovery', () => {
  const [provider] = toSsoProviders([{ ...cloud, issuer: 'https://id.smartup.example/realm/' }]);
  expect(provider?.oidcConfig.discoveryEndpoint).toBe('https://id.smartup.example/realm/.well-known/openid-configuration');
});

test('явные адреса сервера передаются библиотеке', () => {
  const [provider] = toSsoProviders([
    {
      ...cloud,
      endpoints: {
        authorization: 'https://id.smartup.example/a',
        token: 'https://id.smartup.example/t',
        userinfo: 'https://id.smartup.example/u',
        jwks: 'https://id.smartup.example/j',
      },
    },
  ]);
  expect(provider?.oidcConfig).toMatchObject({
    authorizationEndpoint: 'https://id.smartup.example/a',
    tokenEndpoint: 'https://id.smartup.example/t',
    userInfoEndpoint: 'https://id.smartup.example/u',
    jwksEndpoint: 'https://id.smartup.example/j',
  });
});

test('доверенные адреса: портал и серверы реестра, без повторов', () => {
  expect(trustedOriginsFor('https://hub.smartup24.com', [cloud, { ...cloud, code: 'b' }])).toEqual([
    'https://hub.smartup24.com',
    'https://id.smartup.example',
  ]);
  expect(
    trustedOriginsFor('http://localhost:3000', [
      { ...cloud, issuer: 'http://localhost:3190/' },
      { ...cloud, endpoints: { authorization: 'https://auth.other.example/a', token: 'https://id.smartup.example/t', userinfo: 'https://id.smartup.example/u', jwks: 'https://id.smartup.example/j' } },
    ]),
  ).toEqual(['http://localhost:3000', 'http://localhost:3190', 'https://id.smartup.example', 'https://auth.other.example']);
});
