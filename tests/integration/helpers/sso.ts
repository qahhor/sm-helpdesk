import { Events, OAuth2Server } from 'oauth2-mock-server';
import type { SystemActor } from '@/db/with-actor';
import { handleAuthRequest } from '@/modules/hdu/api/auth-route';
import { readSession, type SessionData } from '@/modules/hdu/api/request';
import { addServer } from '@/modules/hdu/api/servers';
import { startSmartupSignIn } from '@/modules/hdu/api/sso';
import { newJar, type TestRequest } from './auth';

// Ложные серверы Smartup для интеграционных тестов: настоящий поток OpenID Connect с PKCE,
// подписанным id_token и сведениями о пользователе. Каждый вход получает свои сведения (setNextClaims).

export type Claims = Record<string, unknown> & { sub: string };

export type MockServer = {
  code: string;
  url: string;
  setNextClaims(claims: Claims): void;
  /** Сервер не выполняет prompt=login и max_age=0: входа заново нет, auth_time остаётся временем прежнего входа. */
  setIgnoresPrompt(ignores: boolean): void;
  /** В id_token нет auth_time: проверить, выполнен ли новый вход, портал не может. */
  setOmitsAuthTime(omits: boolean): void;
  /** Параметры последнего запроса авторизации. */
  lastAuthorize(): URLSearchParams;
  stop(): Promise<void>;
};

const system: SystemActor = { type: 'system', job: 'test' };

export async function startMockOidc(code: string, port: number): Promise<MockServer> {
  const server = new OAuth2Server();
  await server.issuer.keys.generate('RS256');
  await server.start(port, '127.0.0.1');
  // Адрес сервера входа должен совпасть с тем, что записан в реестре портала.
  server.issuer.url = `http://localhost:${port}`;
  let next: Claims = { sub: 'nobody' };
  // У Smartup Web уже открыта сессия: вход в ней был час назад. prompt=login или max_age=0 требуют войти заново,
  // тогда auth_time равен текущему времени (OpenID Connect Core 1.0, 3.1.2.1).
  const smartupSessionSince = Math.floor(Date.now() / 1000) - 3600;
  let ignoresPrompt = false;
  let omitsAuthTime = false;
  let authorize = new URLSearchParams();
  server.service.on(Events.BeforeAuthorizeRedirect, (_redirect: unknown, req: { url?: string; originalUrl?: string }) => {
    authorize = new URL(req.originalUrl ?? req.url ?? '/', 'http://mock').searchParams;
  });
  server.service.on(Events.BeforeTokenSigning, (token: { payload: Record<string, unknown> }) => {
    const reauth = !ignoresPrompt && (authorize.get('prompt') === 'login' || authorize.get('max_age') === '0');
    Object.assign(token.payload, { auth_time: reauth ? Math.floor(Date.now() / 1000) : smartupSessionSince }, next);
    if (omitsAuthTime) delete token.payload.auth_time;
  });
  server.service.on(Events.BeforeUserinfo, (response: { body: Record<string, unknown> }) => {
    response.body = { ...next };
  });
  return {
    code,
    url: server.issuer.url,
    setNextClaims: (claims) => {
      next = claims;
    },
    setIgnoresPrompt: (ignores) => {
      ignoresPrompt = ignores;
    },
    setOmitsAuthTime: (omits) => {
      omitsAuthTime = omits;
    },
    lastAuthorize: () => authorize,
    stop: () => server.stop(),
  };
}

/** Регистрирует ложный сервер в реестре портала. Реестр очищается перед каждым тестом. */
export async function registerMock(mock: MockServer, opts: { isDefault?: boolean; roleMap?: Record<string, string> } = {}): Promise<void> {
  await addServer(system, {
    code: mock.code,
    name: `Ложный ${mock.code}`,
    baseUrl: mock.url,
    issuer: mock.url,
    clientId: 'hub',
    clientSecret: 'mock-client-secret',
    isDefault: opts.isDefault ?? false,
    roleMap: opts.roleMap,
  });
}

/** Запрос с запомненным выбором сервера (кука hub_server), как у клиента выделенного сервера. */
export function requestWithServerCookie(code: string): TestRequest {
  return newJar({ cookie: `hub_server=${code}` }).request;
}

/**
 * Полный вход клиента через ложный сервер: начало входа на портале, страница сервера,
 * возврат на единственный открытый адрес библиотеки входа. Возвращает сессию.
 */
export async function ssoSignIn(mock: MockServer, claims: Claims, opts: { next?: string; reauth?: boolean } = {}): Promise<SessionData> {
  mock.setNextClaims(claims);
  const jar = newJar({ cookie: `hub_server=${mock.code}`, 'x-forwarded-for': '203.0.113.30' });
  const started = await startSmartupSignIn({ locale: 'ru', next: opts.next, ...(opts.reauth ? { reauth: true } : {}) }, jar.request);
  if (!('url' in started)) throw new Error(`Вход не начался: ${started.error}`);
  const authorize = await fetch(started.url, { redirect: 'manual' });
  const callback = authorize.headers.get('location');
  if (!callback) throw new Error('Ложный сервер не вернул адрес возврата');
  const response = await handleAuthRequest(new Request(callback, { headers: jar.request.headers }));
  if (response.status !== 302) throw new Error(`Возврат с сервера: ${response.status} ${await response.text()}`);
  const location = response.headers.get('location') ?? '';
  if (/[?&]error=/.test(location)) throw new Error(`Вход отклонён: ${location}`);
  jar.request.setCookies(response.headers);
  const session = await readSession(jar.request);
  if (!session) throw new Error('После входа нет сессии');
  return session;
}
