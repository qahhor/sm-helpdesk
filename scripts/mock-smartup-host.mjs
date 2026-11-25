// Демонстрационная страница Smartup Web для разработки и браузерных тестов виджета (план M6, задача 9, решение 17).
// В образ не входит: только для разработки (решение 0013).
//
// Страница работает на своём адресе http://127.0.0.1:3195: это другой сайт, чем портал на localhost, поэтому iframe
// виджета на ней сторонний, как в настоящем Smartup Web. Она подключает загрузчик портала /widget/v1/hub-widget.js,
// берёт токен контекста у ложного сервера mock (scripts/mock-oidc.mjs, POST /context-token) и вызывает
// SmartupHub.init, open и reportError. Меню "Помощь", кнопка "Вызвать ошибку", тема, язык, режим без getContextToken.
//
// Второй адрес http://127.0.0.1:3196 отдаёт ту же страницу как посторонний сайт: его нет в адресах встраивания
// сервера, и браузер не должен показать на нём портал (frame-ancestors).
//
// Порты 3192 и 3194 из плана заняты ложными Telegram и трекером задач (решение 0060).
//
// Запуск: pnpm dev:host. Ключ встраивания сервера mock печатает pnpm dev:up (адрес вида /?key=...); его же можно
// задать переменной HUB_EMBED_KEY. Параметры адреса страницы:
//   key        ключ встраивания сервера (32 шестнадцатеричных знака)
//   persona    персона ложного сервера (alisher, dilnoza, timur) или custom с полями claim_sub, claim_name, ...
//   platform   web, android, ios
//   locale     ru, uz, en;  theme  light, dark
//   mode       a (по умолчанию), b (без getContextToken), fail (getContextToken отвечает ошибкой)
//   module, form, appVersion  подсказки хозяина (getHints)
import { createServer } from 'node:http';

export const MOCK_HOST_PORT = Number(process.env.MOCK_HOST_PORT ?? 3195);
export const MOCK_FOREIGN_PORT = Number(process.env.MOCK_FOREIGN_PORT ?? 3196);
export const MOCK_HOST_ORIGIN = `http://127.0.0.1:${MOCK_HOST_PORT}`;
const HUB_URL = (process.env.HUB_URL ?? 'http://localhost:3000').replace(/\/$/, '');
const ISSUER_URL = (process.env.MOCK_ISSUER_URL ?? 'http://localhost:3190').replace(/\/$/, '');
const DEFAULT_KEY = process.env.HUB_EMBED_KEY ?? '';

const escapeHtml = (/** @type {string} */ text) =>
  text.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char] ?? char);

/** Настройки страницы из адреса. Значения идут в страницу только через JSON внутри скрипта (с экранированием <). */
function configOf(/** @type {URL} */ url, /** @type {boolean} */ foreign) {
  const query = url.searchParams;
  const token = new URLSearchParams({ persona: query.get('persona') ?? 'alisher', platform: query.get('platform') ?? 'web' });
  for (const [name, value] of query) if (name.startsWith('claim_')) token.set(name, value);
  /** @type {Record<string, string>} */
  const hints = {};
  for (const name of ['module', 'form', 'appVersion']) {
    const value = query.get(name);
    if (value) hints[name] = value;
  }
  return {
    hubUrl: HUB_URL,
    embedKey: query.get('key') ?? DEFAULT_KEY,
    locale: ['ru', 'uz', 'en'].includes(query.get('locale') ?? '') ? query.get('locale') : 'ru',
    theme: query.get('theme') === 'dark' ? 'dark' : 'light',
    mode: ['b', 'fail'].includes(query.get('mode') ?? '') ? query.get('mode') : 'a',
    tokenUrl: `${ISSUER_URL}/context-token?${token}`,
    hints,
    foreign,
  };
}

/** Страница хозяина. Стили и сценарий встроены: у демонстрационной страницы нет своей политики CSP. */
function hostPage(/** @type {ReturnType<typeof configOf>} */ config) {
  const json = JSON.stringify(config).replace(/</g, '\\u003c');
  const title = config.foreign ? 'Посторонний сайт' : 'Smartup Web (демонстрация)';
  return `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
  body { font-family: system-ui, sans-serif; margin: 0; color: #1f2933; background: #f5f7fa; }
  body.dark { color: #e4e7eb; background: #1f2933; }
  header { display: flex; flex-wrap: wrap; gap: 12px; align-items: center; padding: 12px 16px; background: #0b5394; color: #fff; }
  header h1 { font-size: 18px; margin: 0; flex: 1 1 auto; }
  main { padding: 16px; display: flex; flex-direction: column; gap: 16px; max-width: 720px; }
  fieldset { display: flex; flex-wrap: wrap; gap: 12px; border: 1px solid #9aa5b1; padding: 12px; }
  button, select, input { font: inherit; }
  .menu { position: relative; }
  .menu [role="menu"] { position: absolute; right: 0; top: 100%; display: flex; flex-direction: column; background: #fff; color: #1f2933; border: 1px solid #9aa5b1; min-width: 220px; z-index: 1; }
  .menu [role="menu"][hidden] { display: none; }
  .menu [role="menuitem"] { text-align: left; padding: 8px 12px; border: 0; background: none; cursor: pointer; }
  .note { font-size: 14px; }
</style></head>
<body>
<header>
  <h1>${escapeHtml(title)}</h1>
  <div class="menu">
    <button type="button" id="help" aria-haspopup="menu" aria-expanded="false">Помощь</button>
    <div role="menu" id="help-menu" hidden>
      <button type="button" role="menuitem" id="help-report">Сообщить о проблеме</button>
      <button type="button" role="menuitem" id="help-tickets">Мои обращения</button>
    </div>
  </div>
</header>
<main>
  <p class="note">Ложная страница для разработки виджета Smartup Hub. Портал: ${escapeHtml(config.hubUrl)}. Режим: ${escapeHtml(String(config.mode))}.</p>
  <div><button type="button" id="raise-error">Вызвать ошибку</button> <button type="button" id="focus-me">Заказы</button></div>
  <fieldset><legend>Настройки</legend>
    <label>Тема <select id="theme"><option value="light">Светлая</option><option value="dark">Тёмная</option></select></label>
    <label>Язык <select id="locale"><option value="ru">Русский</option><option value="uz">O'zbekcha</option><option value="en">English</option></select></label>
    <label>Режим <select id="mode"><option value="a">С токеном (A)</option><option value="b">Без getContextToken (B)</option><option value="fail">Токен с ошибкой (B)</option></select></label>
  </fieldset>
  <form id="key-form"><label>Ключ встраивания <input name="key" size="34" pattern="[0-9a-f]{32}" required></label> <button type="submit">Применить</button></form>
</main>
<script src="${escapeHtml(config.hubUrl)}/widget/v1/hub-widget.js"></script>
<script>
  const config = ${json};
  window.__config = config;
  window.__created = [];
  window.__tokens = 0;
  let theme = config.theme;
  const reload = (name, value) => { const url = new URL(location.href); url.searchParams.set(name, value); location.href = url.toString(); };
  document.body.classList.toggle('dark', theme === 'dark');
  document.getElementById('theme').value = theme;
  document.getElementById('locale').value = config.locale;
  document.getElementById('mode').value = config.mode;
  document.querySelector('#key-form input').value = config.embedKey;
  const options = {
    hubUrl: config.hubUrl,
    embedKey: config.embedKey,
    locale: config.locale,
    // Тема функцией (UX-S-09): загрузчик спрашивает её при каждом открытии.
    theme: () => theme,
    getHints: () => config.hints,
    onTicketCreated: (number) => window.__created.push(number),
  };
  if (config.mode === 'a')
    options.getContextToken = () => {
      window.__tokens += 1;
      return fetch(config.tokenUrl, { method: 'POST' }).then((r) => r.json()).then((r) => r.token);
    };
  if (config.mode === 'fail')
    options.getContextToken = () => {
      window.__tokens += 1;
      return Promise.reject(new Error('Smartup не выдал токен'));
    };
  window.SmartupHub.init(options);
  const help = document.getElementById('help');
  const menu = document.getElementById('help-menu');
  help.addEventListener('click', () => { menu.hidden = !menu.hidden; help.setAttribute('aria-expanded', String(!menu.hidden)); });
  const pick = (mode) => { menu.hidden = true; help.setAttribute('aria-expanded', 'false'); window.SmartupHub.open({ mode }); };
  document.getElementById('help-report').addEventListener('click', () => pick('report'));
  document.getElementById('help-tickets').addEventListener('click', () => pick('tickets'));
  document.getElementById('raise-error').addEventListener('click', () =>
    window.SmartupHub.reportError({ code: 'ORA-20001', message: 'Недостаточно остатка на складе "Основной" для товара "Мука"' }),
  );
  document.getElementById('theme').addEventListener('change', (event) => { theme = event.target.value; document.body.classList.toggle('dark', theme === 'dark'); });
  document.getElementById('locale').addEventListener('change', (event) => reload('locale', event.target.value));
  document.getElementById('mode').addEventListener('change', (event) => reload('mode', event.target.value));
  document.getElementById('key-form').addEventListener('submit', (event) => { event.preventDefault(); reload('key', new FormData(event.target).get('key')); });
</script>
</body></html>`;
}

/** @param {number} port @param {boolean} foreign */
export function startMockHost(port, foreign) {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
    if (url.pathname === '/__health') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('ok');
      return;
    }
    if (url.pathname !== '/' || req.method !== 'GET') {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('Not Found');
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    res.end(hostPage(configOf(url, foreign)));
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)));
}

if (import.meta.main) {
  await startMockHost(MOCK_HOST_PORT, false);
  await startMockHost(MOCK_FOREIGN_PORT, true);
  console.log(`Демонстрационная страница Smartup Web: ${MOCK_HOST_ORIGIN}/ (портал ${HUB_URL})`);
  console.log(`Посторонний сайт: http://127.0.0.1:${MOCK_FOREIGN_PORT}/`);
  if (!DEFAULT_KEY) console.log('Ключ встраивания: параметр ?key= или переменная HUB_EMBED_KEY (его печатает pnpm dev:up)');
}
