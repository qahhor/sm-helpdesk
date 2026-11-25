// @ts-check
// Загрузчик виджета Smartup Hub (ТЗ 11.9, FR-WG-01, 02, 07, 10; план M6, задача 4, решения 8, 9 и 12).
//
// Исходник без зависимостей и без сборщика. Команда pnpm widget:build подставляет тексты из messages/*.json
// (пространство widget.loader), цвета и размеры из src/ui/tokens.css и пишет public/widget/v1/hub-widget.js.
// pnpm check падает, если файл устарел. Бюджет 15 КБ в сжатом виде проверяет модульный тест.
//
// Что делает: кнопка и уведомление в закрытом Shadow DOM (стили хозяина их не задевают), панель с iframe страницы
// виджета с адреса портала, обмен сообщениями postMessage версии 1 со строгой проверкой обеих сторон:
// - входящее принимается, только если event.origin равен адресу портала, а event.source это окно нашего iframe;
// - исходящее уходит только на точный адрес портала, адрес "*" не используется никогда;
// - сообщение проверяется по схеме, неизвестный тип молча отбрасывается.
// Токен контекста загрузчик только передаёт: он не хранит его и не пишет в localStorage и куки. Продление просит
// страница виджета (need-token) за минуту до истечения токена виджета.
// Стили задаются через adoptedStyleSheets и свойства CSSOM: встроенные стили страницы хозяина (unsafe-inline) не нужны.
// Без getContextToken или при его ошибке виджет открывает портал в новой вкладке (режим B, задача 8 плана M6).

(function () {
  'use strict';

  /** @type {Record<string, Record<string, string>>} */
  var TEXTS = /*__HUB_TEXTS__*/ {};
  /** @type {{ light: Record<string, string>, dark: Record<string, string>, sizes: Record<string, string> }} */
  var THEME = /*__HUB_THEME__*/ { light: {}, dark: {}, sizes: {} };

  var PROTOCOL = 1;
  var LOCALES = ['ru', 'uz', 'en'];
  var EMBED_KEY = /^[0-9a-f]{32}$/;
  var HINT_CODE = /^[A-Za-z0-9_.:-]{1,64}$/;
  var FRAME_TYPES = ['ready', 'need-token', 'close', 'ticket-created'];

  /**
   * @typedef {{ module?: string, form?: string, appVersion?: string, errorCode?: string, errorText?: string }} Hints
   * @typedef {{
   *   hubUrl: string,
   *   embedKey: string,
   *   locale?: string,
   *   theme?: string | (() => string),
   *   button?: boolean,
   *   getContextToken?: () => Promise<string> | string,
   *   getHints?: () => Hints,
   *   onTicketCreated?: (number: number) => void,
   * }} InitOptions
   * @typedef {{ hubOrigin: string, embedKey: string, locale: string, opts: InitOptions }} Config
   */

  /**
   * Адрес портала: https, http только для localhost и 127.0.0.1 (разработка). Иначе null.
   * @param {unknown} raw
   * @returns {string | null}
   */
  function hubOriginOf(raw) {
    if (typeof raw !== 'string') return null;
    try {
      var url = new URL(raw);
      var loopback = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
      if (url.protocol !== 'https:' && !(loopback && url.protocol === 'http:')) return null;
      return url.origin;
    } catch {
      return null;
    }
  }

  /**
   * Строка подсказки: обрезана по длине, без управляющих знаков. Неверная подсказка отбрасывается (решение 11).
   * @param {unknown} value @param {number} max @param {RegExp} [pattern]
   * @returns {string | undefined}
   */
  function hint(value, max, pattern) {
    if (typeof value !== 'string' && typeof value !== 'number') return undefined;
    var text = String(value).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').trim().slice(0, max);
    if (!text || (pattern && !pattern.test(text))) return undefined;
    return text;
  }

  /**
   * Подсказки страницы хозяина и сведения последней ошибки. Сбой getHints форму не ломает.
   * @param {InitOptions} opts @param {{ code?: unknown, message?: unknown } | null} error
   * @returns {Hints}
   */
  function collectHints(opts, error) {
    /** @type {Record<string, unknown>} */
    var raw = {};
    try {
      raw = (opts.getHints && opts.getHints()) || {};
    } catch {
      raw = {};
    }
    /** @type {Hints} */
    var hints = {};
    var moduleCode = hint(raw.module, 64, HINT_CODE);
    var form = hint(raw.form, 64, HINT_CODE);
    var appVersion = hint(raw.appVersion, 32);
    if (moduleCode) hints.module = moduleCode;
    if (form) hints.form = form;
    if (appVersion) hints.appVersion = appVersion;
    if (error) {
      var errorCode = hint(error.code, 64);
      var errorText = hint(error.message, 2000);
      if (errorCode) hints.errorCode = errorCode;
      if (errorText) hints.errorText = errorText;
    }
    return hints;
  }

  /**
   * Сообщение страницы виджета: { hub: 1, type, ... } из известного списка. Иначе null.
   * @param {unknown} data
   * @returns {{ type: string, number?: number } | null}
   */
  function parseFrameMessage(data) {
    if (typeof data !== 'object' || data === null) return null;
    /** @type {Record<string, unknown>} */
    var message = /** @type {Record<string, unknown>} */ (data);
    if (message.hub !== PROTOCOL || typeof message.type !== 'string' || FRAME_TYPES.indexOf(message.type) < 0) return null;
    if (message.type === 'ticket-created') {
      var number = message.number;
      if (typeof number !== 'number' || !Number.isSafeInteger(number) || number <= 0) return null;
      return { type: message.type, number: number };
    }
    return { type: message.type };
  }

  /**
   * Таблица стилей Shadow DOM: цвета и размеры подставлены сборкой из токенов портала.
   * @returns {string}
   */
  function css() {
    /** @param {Record<string, string>} vars */
    var block = function (vars) {
      return Object.keys(vars)
        .map(function (name) {
          return '--' + name + ':' + vars[name] + ';';
        })
        .join('');
    };
    var s = THEME.sizes;
    return [
      ':host{all:initial;' + block(THEME.light) + '}',
      ':host([data-theme="dark"]){' + block(THEME.dark) + '}',
      '*{box-sizing:border-box;font-family:' + s.font + ';font-size:' + s.text + ';line-height:1.35}',
      '.btn{position:fixed;inset-block-end:16px;inset-inline-end:16px;z-index:2147483000;min-height:' + s.control +
        ';padding:0 16px;border:0;border-radius:' + s.chip + ';background:var(--pri);color:var(--on-pri);cursor:pointer;box-shadow:0 8px 24px var(--shadow)}',
      '.btn:hover{background:var(--pri-hover)}',
      'button:focus-visible{outline:2px solid var(--pri);outline-offset:2px}',
      '.panel{position:fixed;inset-block:0;inset-inline-end:0;z-index:2147483001;width:400px;max-width:100%;background:var(--card);border-inline-start:1px solid var(--line);box-shadow:0 8px 24px var(--shadow)}',
      '.panel[hidden],.toast[hidden],.btn[hidden]{display:none}',
      '.panel iframe{display:block;width:100%;height:100%;border:0;background:var(--card)}',
      '@media (max-width:' + s.tablet + '){.panel{width:100%;border:0}}',
      '.toast{position:fixed;inset-block-end:16px;inset-inline-end:16px;z-index:2147483002;max-width:360px;padding:12px 16px;border:1px solid var(--line);border-radius:' +
        s.card + ';background:var(--card);color:var(--ink);box-shadow:0 8px 24px var(--shadow);display:flex;flex-direction:column;gap:8px}',
      '.toast p{margin:0;color:var(--ink);overflow-wrap:anywhere}',
      '.toast .muted{color:var(--ink2)}',
      '.row{display:flex;gap:8px;flex-wrap:wrap}',
      '.row button{min-height:' + s.control + ';padding:0 12px;border-radius:' + s.radius + ';cursor:pointer;border:1px solid var(--line);background:var(--card);color:var(--ink)}',
      '.row .primary{border:0;background:var(--pri);color:var(--on-pri)}',
    ].join('\n');
  }

  /**
   * Ставит интерфейс SmartupHub в окно хозяина.
   * @param {Window & typeof globalThis} win
   */
  function install(win) {
    var doc = win.document;
    /** @type {Config | null} */
    var config = null;
    /** @type {HTMLElement | null} */
    var host = null;
    /** @type {ShadowRoot | null} */
    var root = null;
    /** @type {HTMLButtonElement | null} */
    var button = null;
    /** @type {HTMLElement | null} */
    var panel = null;
    /** @type {HTMLIFrameElement | null} */
    var frame = null;
    var frameMode = '';
    /** @type {HTMLElement | null} */
    var toast = null;
    /** @type {{ code?: unknown, message?: unknown } | null} */
    var lastError = null;
    /** @type {Element | null} */
    var returnFocus = null;
    var frameReady = false;
    var toastTimer = 0;

    /** @param {string} key */
    function t(key) {
      var locale = config ? config.locale : 'ru';
      return (TEXTS[locale] && TEXTS[locale][key]) || (TEXTS.ru && TEXTS.ru[key]) || key;
    }

    function theme() {
      if (!config) return 'light';
      var value = config.opts.theme;
      try {
        if (typeof value === 'function') value = value();
      } catch {
        value = 'light';
      }
      return value === 'dark' ? 'dark' : 'light';
    }

    /** @param {string} tag @param {string} [className] @param {string} [text] */
    function el(tag, className, text) {
      var node = doc.createElement(tag);
      if (className) node.className = className;
      if (text) node.textContent = text;
      return node;
    }

    function ensureRoot() {
      if (root && host) return root;
      host = el('div');
      host.setAttribute('data-smartup-hub', '');
      root = host.attachShadow({ mode: 'closed' });
      var styles = css();
      var shadow = /** @type {ShadowRoot & { adoptedStyleSheets?: CSSStyleSheet[] }} */ (root);
      if (typeof win.CSSStyleSheet === 'function' && 'adoptedStyleSheets' in shadow) {
        var sheet = new win.CSSStyleSheet();
        sheet.replaceSync(styles);
        shadow.adoptedStyleSheets = [sheet];
      } else {
        // Старый браузер без таблиц стилей CSSOM: элемент style (страница хозяина может его запретить политикой CSP).
        root.appendChild(el('style', '', styles));
      }
      doc.body.appendChild(host);
      return root;
    }

    function applyTheme() {
      if (host) host.setAttribute('data-theme', theme());
    }

    /**
     * Сообщение странице виджета. Только на точный адрес портала и только в окно нашего iframe.
     * @param {Record<string, unknown>} message
     */
    function send(message) {
      if (!config || !frame || !frame.contentWindow) return;
      message.hub = PROTOCOL;
      frame.contentWindow.postMessage(message, config.hubOrigin);
    }

    /** @param {(token: string) => void} done @param {() => void} failed */
    function requestToken(done, failed) {
      var get = config && config.opts.getContextToken;
      if (typeof get !== 'function') return failed();
      var result;
      try {
        result = get();
      } catch {
        return failed();
      }
      Promise.resolve(result).then(
        function (token) {
          if (typeof token === 'string' && token.length > 0 && token.length <= 8192) done(token);
          else failed();
        },
        function () {
          failed();
        },
      );
    }

    /**
     * Режим B (FR-WG-04): портал в новой вкладке с обычным входом. Подсказки идут после #, чтобы текст ошибки не попал
     * в журнал сервера (решение 12). Страницу портала, которая их подставляет, строит задача 8 плана M6.
     * @param {Hints} hints
     */
    function openModeB(hints) {
      if (!config) return;
      close();
      var url = config.hubOrigin + '/' + config.locale + '/tickets/new#widget=1&hints=' + encodeURIComponent(JSON.stringify(hints));
      win.open(url, '_blank', 'noopener,noreferrer');
    }

    /** @param {MessageEvent} event */
    function onMessage(event) {
      // Строгая проверка источника: только адрес портала и только окно нашего iframe (решение 8).
      if (!config || !frame || event.origin !== config.hubOrigin || event.source !== frame.contentWindow) return;
      var message = parseFrameMessage(event.data);
      if (!message) return;
      if (message.type === 'ready') {
        frameReady = true;
        var hints = collectHints(config.opts, lastError);
        requestToken(
          function (token) {
            send({ type: 'init', token: token, hints: hints, theme: theme(), locale: config ? config.locale : 'ru' });
          },
          function () {
            openModeB(hints);
          },
        );
      } else if (message.type === 'need-token') {
        requestToken(
          function (token) {
            send({ type: 'token', token: token });
          },
          function () {},
        );
      } else if (message.type === 'close') {
        close();
      } else if (message.type === 'ticket-created' && message.number) {
        lastError = null;
        var callback = config.opts.onTicketCreated;
        if (typeof callback === 'function') {
          try {
            callback(message.number);
          } catch {
            // Ошибка обработчика хозяина виджет не ломает.
          }
        }
      }
    }

    /** @param {KeyboardEvent} event */
    function onKey(event) {
      if (event.key === 'Escape' && panel && !panel.hidden) close();
    }

    /** @param {string} mode */
    function frameUrl(mode) {
      if (!config) return '';
      // Ключ встраивания выбирает адреса, которым можно встраивать страницу (frame-ancestors, решение 6). Адрес хозяина
      // нужен браузерам без location.ancestorOrigins: страница сверяет его со списком сервера.
      return (
        config.hubOrigin + '/' + config.locale + '/embed/' + mode + '?key=' + config.embedKey + '&origin=' + encodeURIComponent(win.location.origin)
      );
    }

    /** @param {{ mode?: unknown }} [options] */
    function open(options) {
      if (!config) return;
      var mode = options && options.mode === 'tickets' ? 'tickets' : 'report';
      var hints = collectHints(config.opts, lastError);
      if (typeof config.opts.getContextToken !== 'function') return openModeB(hints);
      var shadow = ensureRoot();
      applyTheme();
      hideToast();
      var wasOpen = Boolean(panel && !panel.hidden);
      if (!panel) {
        panel = el('div', 'panel');
        panel.setAttribute('role', 'dialog');
        panel.setAttribute('aria-label', t('panelTitle'));
        shadow.appendChild(panel);
      }
      if (!frame || frameMode !== mode) {
        if (frame) panel.removeChild(frame);
        frameReady = false;
        frame = /** @type {HTMLIFrameElement} */ (el('iframe'));
        frame.title = t('panelTitle');
        frame.referrerPolicy = 'no-referrer';
        frame.src = frameUrl(mode);
        frameMode = mode;
        panel.appendChild(frame);
      } else if (frameReady) {
        // Панель открыта снова: свежие подсказки (новая ошибка, другой экран).
        send({ type: 'hints', hints: hints });
      }
      if (!wasOpen) returnFocus = doc.activeElement;
      panel.hidden = false;
      if (button) button.hidden = true;
      frame.focus();
    }

    function close() {
      if (!panel || panel.hidden) return;
      panel.hidden = true;
      if (button) button.hidden = false;
      var target = /** @type {HTMLElement | null} */ (returnFocus);
      returnFocus = null;
      if (target && typeof target.focus === 'function') target.focus();
    }

    function hideToast() {
      if (toast) toast.hidden = true;
      if (toastTimer) win.clearTimeout(toastTimer);
      toastTimer = 0;
    }

    /**
     * Ошибка в Smartup (FR-WG-07): уведомление с кнопкой "Сообщить". Панель сама не открывается.
     * @param {{ code?: unknown, message?: unknown }} [error]
     */
    function reportError(error) {
      if (!config) return;
      lastError = { code: error && error.code, message: error && error.message };
      if (panel && !panel.hidden) return;
      var shadow = ensureRoot();
      applyTheme();
      if (toast) shadow.removeChild(toast);
      toast = el('div', 'toast');
      toast.setAttribute('role', 'status');
      toast.appendChild(el('p', '', t('toastTitle')));
      var text = hint(lastError.message, 200);
      if (text) toast.appendChild(el('p', 'muted', text));
      var row = el('div', 'row');
      var report = el('button', 'primary', t('toastReport'));
      report.setAttribute('type', 'button');
      report.addEventListener('click', function () {
        open({ mode: 'report' });
      });
      var dismiss = el('button', '', t('toastDismiss'));
      dismiss.setAttribute('type', 'button');
      dismiss.addEventListener('click', function () {
        lastError = null;
        hideToast();
      });
      row.appendChild(report);
      row.appendChild(dismiss);
      toast.appendChild(row);
      shadow.appendChild(toast);
      if (toastTimer) win.clearTimeout(toastTimer);
      toastTimer = win.setTimeout(hideToast, 20000);
    }

    /** @param {InitOptions} opts */
    function init(opts) {
      if (config || !opts) return;
      var hubOrigin = hubOriginOf(opts.hubUrl);
      if (!hubOrigin || typeof opts.embedKey !== 'string' || !EMBED_KEY.test(opts.embedKey)) {
        if (win.console) win.console.error('SmartupHub.init: hubUrl or embedKey is invalid');
        return;
      }
      var locale = typeof opts.locale === 'string' && LOCALES.indexOf(opts.locale) >= 0 ? opts.locale : 'ru';
      config = { hubOrigin: hubOrigin, embedKey: opts.embedKey, locale: locale, opts: opts };
      win.addEventListener('message', onMessage);
      doc.addEventListener('keydown', onKey);
      if (opts.button !== false) {
        var shadow = ensureRoot();
        applyTheme();
        button = /** @type {HTMLButtonElement} */ (el('button', 'btn', t('button')));
        button.setAttribute('type', 'button');
        button.addEventListener('click', function () {
          open({ mode: 'report' });
        });
        shadow.appendChild(button);
      }
    }

    return { version: PROTOCOL, init: init, open: open, close: close, reportError: reportError };
  }

  var target = /** @type {Window & typeof globalThis & { SmartupHub?: unknown }} */ (window);
  if (!target.SmartupHub) target.SmartupHub = install(target);
})();
