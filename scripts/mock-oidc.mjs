// Ложный сервер Smartup для разработки и браузерных тестов: настоящий поток OpenID Connect
// (документ discovery, PKCE, подписанный id_token, сведения о пользователе), но вместо входа
// в Smartup страница выбора персоны. В образ не входит: только для разработки (решение 0013).
//
// Запуск: pnpm dev:oidc. Три сервера: mock на порту 3190 (общее облако), mock-dedicated на 3191
// (выделенный сервер) и mock-spare на 3193 (для проверки реестра в разделе "Настройки").
// В реестр портала первые два записывает scripts/dev-up.mjs --prepare.
//
// Токен контекста виджета (план M6, решение 17): POST /context-token?persona=<ключ>&platform=web|android|ios.
// Сервер mock подписывает его ES256, открытые ключи отдаёт по адресу /context-jwks.json (режим jwks реестра).
// Сервер mock-dedicated подписывает HS256 общим секретом (режим secret): секрет создаёт портал на карточке сервера,
// его передают ложному серверу переменной MOCK_CONTEXT_SECRET, как разработчикам Smartup.
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { Events, OAuth2Issuer, OAuth2Service } from 'oauth2-mock-server';

/** @typedef {{ sub: string; name: string; email?: string; company_id?: string; company_name?: string; inn?: string; role?: string; locale?: string }} Persona */

/** @typedef {{ mode: 'jwks' } | { mode: 'secret'; secret?: string }} ContextConfig */
/** @typedef {{ port: number; personas: Record<string, Persona & { note: string }>; context?: ContextConfig }} MockConfig */

/** @type {Record<string, MockConfig>} */
export const MOCK_SERVERS = {
  mock: {
    port: 3190,
    context: { mode: 'jwks' },
    personas: {
      alisher: { sub: '1001', name: 'Алишер', company_id: '501', company_name: 'ACME Trade', note: 'без email' },
      dilnoza: {
        sub: '1002',
        name: 'Дильноза',
        email: 'dilnoza@acme.test',
        company_id: '501',
        company_name: 'ACME Trade',
        role: 'director',
        note: 'роль director, есть email',
      },
      timur: { sub: '2001', name: 'Тимур', email: 'dilnoza@acme.test', company_id: '502', company_name: 'Globex', note: 'тот же email, что у Дильнозы' },
      nocompany: { sub: '3001', name: 'Без компании', note: 'Smartup не передал компанию' },
    },
  },
  'mock-dedicated': {
    port: 3191,
    context: { mode: 'secret' },
    personas: {
      alisher: { sub: '1001', name: 'Алишер', company_id: '501', company_name: 'Initech', note: 'тот же sub на другом сервере' },
    },
  },
  // В реестр не записывается: на нём браузерный тест добавляет сервер через раздел "Настройки".
  'mock-spare': {
    port: 3193,
    personas: {
      alisher: { sub: '1001', name: 'Алишер', company_id: '501', company_name: 'Hooli', note: 'сервер для проверки реестра' },
    },
  },
};

const CLAIM_FIELDS = ['sub', 'name', 'email', 'company_id', 'company_name', 'inn', 'role', 'locale'];
const escapeHtml = (/** @type {string} */ text) =>
  text.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char] ?? char);

/** Сведения персоны без служебной пометки и пустых полей. @param {Record<string, unknown>} source */
function claimsOf(source) {
  /** @type {Record<string, string>} */
  const claims = {};
  for (const field of CLAIM_FIELDS) {
    const value = source[field];
    if (typeof value === 'string' && value.trim() !== '') claims[field] = value.trim();
  }
  return claims;
}

/** @param {string} code @param {URL} url @param {Record<string, Persona & { note: string }>} personas */
function personaPage(code, url, personas) {
  const link = (/** @type {string} */ key) => {
    const target = new URL(url);
    target.searchParams.set('persona', key);
    return `${target.pathname}${target.search}`;
  };
  const hidden = [...url.searchParams].map(([key, value]) => `<input type="hidden" name="${escapeHtml(key)}" value="${escapeHtml(value)}">`).join('');
  const rows = Object.entries(personas)
    .map(([key, p]) => `<li><a href="${escapeHtml(link(key))}">${escapeHtml(key)}</a> ${escapeHtml(p.name)}, sub ${escapeHtml(p.sub)}: ${escapeHtml(p.note)}</li>`)
    .join('');
  const fields = CLAIM_FIELDS.map((field) => `<label>${field} <input name="claim_${field}"></label>`).join('<br>');
  return `<!doctype html><html lang="ru"><meta charset="utf-8"><title>Ложный сервер ${escapeHtml(code)}</title>
<h1>Ложный сервер Smartup "${escapeHtml(code)}"</h1>
<p><strong>Ложный сервер для разработки.</strong> Выберите, кем войти.</p>
<ul>${rows}</ul>
<h2>Своя персона</h2>
<form method="get" action="/authorize">${hidden}<input type="hidden" name="persona" value="custom">${fields}<br><button type="submit">Войти</button></form>
</html>`;
}

const CONTEXT_PLATFORMS = ['web', 'android', 'ios'];

/** @param {import('node:http').ServerResponse} res @param {number} status @param {unknown} body */
function sendJson(res, status, body) {
  // Демонстрационная страница Smartup Web (другой адрес) берёт токен из браузера, как Smartup Web со своего сервера.
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', 'access-control-allow-origin': '*' });
  res.end(JSON.stringify(body));
}

/**
 * Выпуск токена контекста (ТЗ 11.4): поля персоны, получатель smartup-hub, срок 2 минуты, новый jti.
 * @param {{ issuer: string; persona: Record<string, string>; platform: string; sign: (jwt: SignJWT) => Promise<string>; alg: string; kid?: string }} input
 */
function contextToken({ issuer, persona, platform, sign, alg, kid }) {
  const { sub, ...profile } = persona;
  const now = Math.floor(Date.now() / 1000);
  const jwt = new SignJWT({ ...profile, platform, app_version: '5.12.0-mock' })
    .setProtectedHeader(kid ? { alg, kid, typ: 'JWT' } : { alg, typ: 'JWT' })
    .setIssuer(issuer)
    .setAudience('smartup-hub')
    .setSubject(sub ?? '')
    .setJti(randomUUID())
    .setIssuedAt(now)
    .setExpirationTime(now + 120);
  return sign(jwt);
}

/**
 * Обработчик адресов токена контекста. null: адрес не про токен контекста.
 * @param {string} issuer @param {MockConfig} config
 */
async function contextHandler(issuer, config) {
  const context = config.context;
  if (!context) return null;
  const pair = context.mode === 'jwks' ? await generateKeyPair('ES256', { extractable: true }) : null;
  const jwks = pair ? { keys: [{ ...(await exportJWK(pair.publicKey)), kid: 'mock-context-1', alg: 'ES256', use: 'sig' }] } : null;
  /** @param {import('node:http').IncomingMessage} req @param {import('node:http').ServerResponse} res @param {URL} url */
  return async (req, res, url) => {
    if (url.pathname === '/context-jwks.json' && jwks) {
      sendJson(res, 200, jwks);
      return true;
    }
    if (url.pathname !== '/context-token') return false;
    if (req.method === 'OPTIONS') {
      res.writeHead(204, { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'POST', 'access-control-allow-headers': 'content-type' });
      res.end();
      return true;
    }
    if (req.method !== 'POST') {
      sendJson(res, 405, { error: 'POST' });
      return true;
    }
    const persona = claimsOf(config.personas[url.searchParams.get('persona') ?? ''] ?? {});
    const platform = url.searchParams.get('platform') ?? 'web';
    if (!persona.sub || !CONTEXT_PLATFORMS.includes(platform)) {
      sendJson(res, 400, { error: 'persona или platform' });
      return true;
    }
    if (pair) {
      const token = await contextToken({ issuer, persona, platform, alg: 'ES256', kid: 'mock-context-1', sign: (jwt) => jwt.sign(pair.privateKey) });
      sendJson(res, 200, { token });
      return true;
    }
    const secret = context.mode === 'secret' ? (context.secret ?? process.env.MOCK_CONTEXT_SECRET) : undefined;
    if (!secret) {
      sendJson(res, 503, { error: 'Задайте MOCK_CONTEXT_SECRET: общий секрет с карточки сервера в разделе "Настройки"' });
      return true;
    }
    const token = await contextToken({ issuer, persona, platform, alg: 'HS256', sign: (jwt) => jwt.sign(new TextEncoder().encode(secret)) });
    sendJson(res, 200, { token });
    return true;
  };
}

/**
 * Запускает ложный сервер. Выбор персоны привязывается к коду авторизации, код к токену доступа:
 * одновременные входы разных персон друг другу не мешают.
 * @param {string} code
 * @param {MockConfig} config
 * @returns {Promise<{ url: string; close(): Promise<void> }>}
 */
export async function startMockServer(code, config) {
  const issuer = new OAuth2Issuer();
  issuer.url = `http://localhost:${config.port}`;
  await issuer.keys.generate('RS256');
  const service = new OAuth2Service(issuer);
  /** @type {Map<string, Record<string, string>>} */
  const byCode = new Map();
  /** @type {Map<string, Record<string, string>>} */
  const byToken = new Map();

  service.on(Events.BeforeAuthorizeRedirect, (/** @type {{ url: URL }} */ redirect, /** @type {any} */ req) => {
    const query = req.query ?? {};
    /** @type {Record<string, unknown>} */
    const custom = {};
    for (const field of CLAIM_FIELDS) custom[field] = query[`claim_${field}`];
    const persona = query.persona === 'custom' ? claimsOf(custom) : claimsOf(config.personas[query.persona] ?? {});
    const authCode = redirect.url.searchParams.get('code');
    if (authCode && persona.sub) byCode.set(authCode, persona);
  });
  service.on(Events.BeforeTokenSigning, (/** @type {{ payload: Record<string, unknown> }} */ token, /** @type {any} */ req) => {
    const persona = byCode.get(req.body?.code);
    if (persona) Object.assign(token.payload, persona);
  });
  service.on(Events.BeforeResponse, (/** @type {{ body: Record<string, unknown> }} */ response, /** @type {any} */ req) => {
    const persona = byCode.get(req.body?.code);
    if (persona && typeof response.body.access_token === 'string') byToken.set(response.body.access_token, persona);
    byCode.delete(req.body?.code);
  });
  service.on(Events.BeforeUserinfo, (/** @type {{ body: Record<string, unknown> }} */ response, /** @type {any} */ req) => {
    const token = String(req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
    const persona = byToken.get(token);
    if (persona) response.body = { ...persona };
  });

  const handler = service.requestHandler;
  const context = await contextHandler(issuer.url, config);
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', issuer.url);
    if (context && (await context(req, res, url))) return;
    if (url.pathname === '/authorize' && !url.searchParams.has('persona')) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(personaPage(code, url, config.personas));
      return;
    }
    handler(req, res);
  });
  await new Promise((resolve) => server.listen(config.port, '127.0.0.1', () => resolve(undefined)));
  return { url: issuer.url, close: () => new Promise((resolve) => server.close(() => resolve(undefined))) };
}

if (import.meta.main) {
  for (const [code, config] of Object.entries(MOCK_SERVERS)) {
    const { url } = await startMockServer(code, config);
    console.log(`Ложный сервер Smartup ${code}: ${url}`);
  }
}
