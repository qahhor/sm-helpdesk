import type { OidcEndpoints } from '../schema';
import { SMARTUP_CLAIMS } from '../pref';

// Серверы Smartup из реестра портала в виде, который принимает библиотека входа (решение 0012).
// Секрет клиента OAuth приходит сюда уже расшифрованным и живёт только в памяти процесса.

export type SsoServer = {
  code: string;
  issuer: string;
  clientId: string;
  clientSecret: string;
  /** Явные адреса сервера. Пусто, если у сервера есть документ discovery. */
  endpoints: OidcEndpoints | null;
};

const trimSlash = (url: string) => url.replace(/\/+$/, '');

export function toSsoProviders(servers: readonly SsoServer[]) {
  return servers.map((server) => ({
    // Код сервера записывается в способ входа пользователя (auth.account.providerId) и не меняется.
    providerId: server.code,
    // Библиотека требует домен. Вход по домену адреса портал не использует, поэтому значение служебное.
    domain: `${server.code}.sso.invalid`,
    oidcConfig: {
      issuer: server.issuer,
      clientId: server.clientId,
      clientSecret: server.clientSecret,
      pkce: true,
      discoveryEndpoint: `${trimSlash(server.issuer)}/.well-known/openid-configuration`,
      scopes: ['openid', 'profile', 'email'],
      ...(server.endpoints && {
        authorizationEndpoint: server.endpoints.authorization,
        tokenEndpoint: server.endpoints.token,
        userInfoEndpoint: server.endpoints.userinfo,
        jwksEndpoint: server.endpoints.jwks,
      }),
      mapping: {
        // Smartup чаще не передаёт email, а библиотека без этого поля вход останавливает.
        // Поэтому поле email берётся из sub. Настоящий адрес, если он есть, приходит отдельным полем.
        // Личность пользователя задаёт sub: его библиотека берёт из проверенного токена сама.
        email: 'sub',
        name: 'name',
        extraFields: { ...SMARTUP_CLAIMS },
      },
    },
  }));
}

export type SsoProviderConfig = ReturnType<typeof toSsoProviders>[number];

/**
 * Адреса, которым библиотека доверяет: сам портал и серверы входа из реестра.
 * Без адреса сервера в этом списке библиотека не обращается к его документу discovery и адресам.
 */
export function trustedOriginsFor(baseUrl: string, servers: readonly SsoServer[]): string[] {
  const origins = [new URL(baseUrl).origin];
  for (const server of servers)
    for (const url of [server.issuer, ...(server.endpoints ? Object.values(server.endpoints) : [])]) {
      const origin = new URL(url).origin;
      if (!origins.includes(origin)) origins.push(origin);
    }
  return origins;
}
