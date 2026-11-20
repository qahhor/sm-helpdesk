// Ложный сервер Smartup для разработки и браузерных тестов: настоящий поток OpenID Connect
// (документ discovery, PKCE, подписанный id_token, сведения о пользователе), но вместо входа
// в Smartup страница выбора персоны. В образ не входит: только для разработки (решение 0013).
//
// Запуск: pnpm dev:oidc. Три сервера: mock на порту 3190 (общее облако), mock-dedicated на 3191
// (выделенный сервер) и mock-spare на 3193 (для проверки реестра в разделе "Настройки").
// В реестр портала первые два записывает scripts/dev-up.mjs --prepare.
import { createServer } from 'node:http';
import { Events, OAuth2Issuer, OAuth2Service } from 'oauth2-mock-server';

/** @typedef {{ sub: string; name: string; email?: string; company_id?: string; company_name?: string; inn?: string; role?: string; locale?: string }} Persona */

/** @type {Record<string, { port: number; personas: Record<string, Persona & { note: string }> }>} */
export const MOCK_SERVERS = {
  mock: {
    port: 3190,
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

/**
 * Запускает ложный сервер. Выбор персоны привязывается к коду авторизации, код к токену доступа:
 * одновременные входы разных персон друг другу не мешают.
 * @param {string} code
 * @param {{ port: number; personas: Record<string, Persona & { note: string }> }} config
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
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', issuer.url);
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
