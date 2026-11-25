import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import { gzipSync } from 'node:zlib';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { buildWidget, WIDGET_OUTPUT } from '../../scripts/widget-build.mjs';

// Загрузчик виджета (ТЗ 11.9, FR-WG-01, 02, 07, 10; план M6, задача 4, решения 8, 9 и 12).
//
// Проверяется собранный файл public/widget/v1/hub-widget.js: он выполняется в node:vm с простым окном и документом
// (пакета jsdom в проекте нет, новые пакеты не ставятся). Поддельные элементы умеют ровно то, что вызывает загрузчик:
// создать элемент, Shadow DOM, добавить потомка, слушать события, фокус. В настоящем браузере загрузчик проверяет
// tests/e2e/widget-report.spec.ts.

const HUB = 'https://hub.smartup.example';
const HOST = 'https://smartup.example';
const KEY = 'a'.repeat(32);

type Listener = (event: Record<string, unknown>) => void;

class FakeElement {
  tag: string;
  className = '';
  textContent = '';
  hidden = false;
  title = '';
  src = '';
  referrerPolicy = '';
  children: FakeElement[] = [];
  attributes = new Map<string, string>();
  listeners = new Map<string, Listener[]>();
  shadow: (FakeElement & { adoptedStyleSheets: unknown[] }) | null = null;
  contentWindow: { postMessage: ReturnType<typeof vi.fn> } | null = null;
  constructor(
    tag: string,
    private readonly env: Env,
  ) {
    this.tag = tag;
    if (tag === 'iframe') this.contentWindow = { postMessage: vi.fn() };
  }
  setAttribute(name: string, value: string) {
    if (name === 'style') throw new Error('встроенный стиль запрещён политикой CSP хозяина');
    this.attributes.set(name, String(value));
  }
  appendChild(child: FakeElement) {
    this.children.push(child);
    return child;
  }
  removeChild(child: FakeElement) {
    this.children = this.children.filter((c) => c !== child);
    return child;
  }
  addEventListener(type: string, fn: Listener) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }
  attachShadow(init: { mode: string }) {
    expect(init.mode).toBe('closed');
    this.shadow = Object.assign(new FakeElement('#shadow', this.env), { adoptedStyleSheets: [] as unknown[] });
    return this.shadow;
  }
  focus() {
    this.env.doc.activeElement = this;
  }
  click() {
    for (const fn of this.listeners.get('click') ?? []) fn({});
  }
  /** Все потомки, включая содержимое Shadow DOM. */
  all(): FakeElement[] {
    const nested = [...this.children, ...(this.shadow ? [this.shadow] : [])];
    return nested.flatMap((child) => [child, ...child.all()]);
  }
}

type Env = {
  win: Record<string, unknown> & { SmartupHub?: Hub };
  doc: { activeElement: unknown; body: FakeElement; listeners: Map<string, Listener[]> };
  windowListeners: Map<string, Listener[]>;
  open: ReturnType<typeof vi.fn>;
  created: FakeElement[];
  sheets: string[];
};
type Hub = {
  init(opts: Record<string, unknown>): void;
  open(opts?: { mode?: string }): void;
  reportError(error: { code?: string; message?: string }): void;
};

const source = readFileSync(WIDGET_OUTPUT, 'utf8');

function boot(): Env {
  const env = { created: [] as FakeElement[], sheets: [] as string[], windowListeners: new Map(), open: vi.fn() } as unknown as Env;
  const doc = {
    activeElement: null as unknown,
    listeners: new Map<string, Listener[]>(),
    createElement: (tag: string) => {
      const el = new FakeElement(tag, env);
      env.created.push(el);
      return el;
    },
    addEventListener(type: string, fn: Listener) {
      this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
    },
  } as Env['doc'] & { createElement: (tag: string) => FakeElement; addEventListener: (type: string, fn: Listener) => void };
  env.doc = doc;
  doc.body = new FakeElement('body', env);
  class CSSStyleSheet {
    replaceSync(text: string) {
      env.sheets.push(text);
    }
  }
  const win: Env['win'] = {
    document: doc,
    location: { origin: HOST },
    URL,
    console: { error: vi.fn() },
    CSSStyleSheet,
    open: env.open,
    setTimeout: () => 1,
    clearTimeout: () => undefined,
    addEventListener: (type: string, fn: Listener) => env.windowListeners.set(type, [...(env.windowListeners.get(type) ?? []), fn]),
  };
  win.window = win;
  env.win = win;
  runInNewContext(source, win);
  return env;
}

const hub = (env: Env) => env.win.SmartupHub as Hub;
const frameOf = (env: Env) => env.created.find((el) => el.tag === 'iframe') ?? null;
const panelOf = (env: Env) => env.created.find((el) => el.className === 'panel') ?? null;
const flush = () => new Promise((done) => setTimeout(done, 0));
function dispatch(env: Env, event: { origin: string; source: unknown; data: unknown }) {
  for (const fn of env.windowListeners.get('message') ?? []) fn(event);
}
function posted(env: Env): [Record<string, unknown>, string][] {
  return (frameOf(env)?.contentWindow?.postMessage.mock.calls ?? []) as [Record<string, unknown>, string][];
}

let env: Env;
beforeEach(() => {
  env = boot();
});

function initHub(extra: Record<string, unknown> = {}) {
  const getContextToken = vi.fn(async () => 'context.token.value');
  hub(env).init({ hubUrl: `${HUB}/`, embedKey: KEY, locale: 'uz', getContextToken, getHints: () => ({ module: 'orders', form: 'order_edit', appVersion: '5.12.0' }), ...extra });
  return getContextToken;
}

describe('init и панель', () => {
  test('неверный адрес портала или ключ встраивания: виджет не включается', () => {
    hub(env).init({ hubUrl: 'http://hub.smartup.example', embedKey: KEY, getContextToken: () => 't' });
    hub(env).init({ hubUrl: 'javascript:alert(1)', embedKey: KEY, getContextToken: () => 't' });
    expect(env.windowListeners.get('message')).toBeUndefined();
    hub(env).init({ hubUrl: HUB, embedKey: 'not-a-key', getContextToken: () => 't' });
    expect(env.windowListeners.get('message')).toBeUndefined();
    hub(env).open();
    expect(frameOf(env)).toBeNull();
  });

  test('кнопка в закрытом Shadow DOM, стили через adoptedStyleSheets без встроенного стиля', () => {
    initHub();
    const host = env.doc.body.children[0];
    expect(host?.shadow?.adoptedStyleSheets).toHaveLength(1);
    expect(env.sheets[0]).toContain('width:400px');
    expect(env.created.some((el) => el.tag === 'style')).toBe(false);
    expect(env.created.find((el) => el.className === 'btn')?.textContent).toBe('Muammo haqida xabar berish');
  });

  test('open рисует iframe страницы виджета с ключом встраивания и адресом хозяина, фокус уходит в панель', () => {
    initHub();
    const before = { focus: vi.fn() };
    env.doc.activeElement = before;
    hub(env).open({ mode: 'report' });
    const frame = frameOf(env);
    expect(frame?.src).toBe(`${HUB}/uz/embed/report?key=${KEY}&origin=${encodeURIComponent(HOST)}`);
    expect(frame?.referrerPolicy).toBe('no-referrer');
    expect(panelOf(env)?.hidden).toBe(false);
    expect(env.doc.activeElement).toBe(frame);
    hub(env).open({ mode: 'tickets' });
    expect(frameOf(env) && env.created.filter((el) => el.tag === 'iframe').at(-1)?.src).toContain('/uz/embed/tickets?key=');
  });
});

describe('протокол (решение 8)', () => {
  test('ready из нашего iframe с адреса портала: init с токеном только на точный адрес портала', async () => {
    const getContextToken = initHub();
    hub(env).open();
    const frame = frameOf(env) as FakeElement;
    dispatch(env, { origin: HUB, source: frame.contentWindow, data: { hub: 1, type: 'ready' } });
    await flush();
    expect(getContextToken).toHaveBeenCalledTimes(1);
    expect(posted(env)).toEqual([
      [{ hub: 1, type: 'init', token: 'context.token.value', hints: { module: 'orders', form: 'order_edit', appVersion: '5.12.0' }, theme: 'light', locale: 'uz' }, HUB],
    ]);
  });

  test('сообщение с чужого адреса игнорируется', async () => {
    const getContextToken = initHub();
    hub(env).open();
    const frame = frameOf(env) as FakeElement;
    for (const origin of ['https://evil.example', HOST, 'null', `${HUB}:8443`])
      dispatch(env, { origin, source: frame.contentWindow, data: { hub: 1, type: 'ready' } });
    await flush();
    expect(getContextToken).not.toHaveBeenCalled();
    expect(posted(env)).toEqual([]);
  });

  test('сообщение с адреса портала, но из другого окна игнорируется', async () => {
    const getContextToken = initHub();
    hub(env).open();
    dispatch(env, { origin: HUB, source: { postMessage: vi.fn() }, data: { hub: 1, type: 'ready' } });
    dispatch(env, { origin: HUB, source: env.win, data: { hub: 1, type: 'need-token' } });
    await flush();
    expect(getContextToken).not.toHaveBeenCalled();
  });

  test('неверная схема и неизвестный тип отбрасываются', async () => {
    const onTicketCreated = vi.fn();
    const getContextToken = initHub({ onTicketCreated });
    hub(env).open();
    const source = (frameOf(env) as FakeElement).contentWindow;
    for (const data of [null, 'ready', { type: 'ready' }, { hub: 2, type: 'ready' }, { hub: 1, type: 'give-token' }, { hub: 1, type: 'ticket-created', number: '1070' }, { hub: 1, type: 'ticket-created', number: -1 }])
      dispatch(env, { origin: HUB, source, data });
    await flush();
    expect(getContextToken).not.toHaveBeenCalled();
    expect(onTicketCreated).not.toHaveBeenCalled();
    dispatch(env, { origin: HUB, source, data: { hub: 1, type: 'ticket-created', number: 1070 } });
    expect(onTicketCreated).toHaveBeenCalledWith(1070);
  });

  test('need-token: новый токен контекста, только на адрес портала', async () => {
    initHub();
    hub(env).open();
    dispatch(env, { origin: HUB, source: (frameOf(env) as FakeElement).contentWindow, data: { hub: 1, type: 'need-token' } });
    await flush();
    expect(posted(env)).toEqual([[{ hub: 1, type: 'token', token: 'context.token.value' }, HUB]]);
  });

  test('ни одно сообщение не уходит на адрес "*"', async () => {
    initHub();
    hub(env).reportError({ code: 'ORA-20001', message: 'нет остатка' });
    hub(env).open();
    const source = (frameOf(env) as FakeElement).contentWindow;
    for (const type of ['ready', 'need-token']) dispatch(env, { origin: HUB, source, data: { hub: 1, type } });
    await flush();
    hub(env).open();
    expect(posted(env).length).toBeGreaterThanOrEqual(2);
    for (const [, target] of posted(env)) expect(target).toBe(HUB);
  });

  test('close из панели закрывает её и возвращает фокус; Esc тоже закрывает', async () => {
    initHub();
    const before = { focus: vi.fn() };
    env.doc.activeElement = before;
    hub(env).open();
    dispatch(env, { origin: HUB, source: (frameOf(env) as FakeElement).contentWindow, data: { hub: 1, type: 'close' } });
    expect(panelOf(env)?.hidden).toBe(true);
    expect(before.focus).toHaveBeenCalled();
    hub(env).open();
    for (const fn of env.doc.listeners.get('keydown') ?? []) fn({ key: 'Escape' });
    expect(panelOf(env)?.hidden).toBe(true);
  });
});

describe('режим B и уведомление об ошибке', () => {
  test('getContextToken вернул ошибку: портал в новой вкладке, подсказки только после #', async () => {
    initHub({ getContextToken: async () => Promise.reject(new Error('нет сервера')) });
    hub(env).reportError({ code: 'ORA-20001', message: 'нет остатка на складе' });
    hub(env).open();
    dispatch(env, { origin: HUB, source: (frameOf(env) as FakeElement).contentWindow, data: { hub: 1, type: 'ready' } });
    await flush();
    expect(env.open).toHaveBeenCalledTimes(1);
    const [url, target, features] = env.open.mock.calls[0] as [string, string, string];
    expect(target).toBe('_blank');
    expect(features).toBe('noopener,noreferrer');
    const parsed = new URL(url);
    expect(`${parsed.origin}${parsed.pathname}${parsed.search}`).toBe(`${HUB}/uz/tickets/new`);
    expect(JSON.parse(new URLSearchParams(parsed.hash.slice(1)).get('hints') as string)).toMatchObject({ errorCode: 'ORA-20001', errorText: 'нет остатка на складе' });
    expect(posted(env)).toEqual([]);
  });

  test('без getContextToken open сразу открывает режим B', () => {
    hub(env).init({ hubUrl: HUB, embedKey: KEY });
    hub(env).open();
    expect(frameOf(env)).toBeNull();
    expect(env.open).toHaveBeenCalledWith(expect.stringMatching(/^https:\/\/hub\.smartup\.example\/ru\/tickets\/new#widget=1&hints=/), '_blank', 'noopener,noreferrer');
  });

  test('reportError показывает уведомление и не открывает панель (FR-WG-07); "Сообщить" открывает её с ошибкой', async () => {
    initHub();
    hub(env).reportError({ code: 'ORA-20001', message: '<b>нет</b> остатка' });
    expect(frameOf(env)).toBeNull();
    const toast = env.created.find((el) => el.className === 'toast') as FakeElement;
    expect(toast.hidden).toBe(false);
    expect(toast.all().map((el) => el.textContent)).toContain('<b>нет</b> остатка');
    const report = toast.all().find((el) => el.className === 'primary') as FakeElement;
    report.click();
    expect(panelOf(env)?.hidden).toBe(false);
    expect(toast.hidden).toBe(true);
    dispatch(env, { origin: HUB, source: (frameOf(env) as FakeElement).contentWindow, data: { hub: 1, type: 'ready' } });
    await flush();
    expect(posted(env)[0]?.[0]).toMatchObject({ type: 'init', hints: { errorCode: 'ORA-20001', errorText: '<b>нет</b> остатка' } });
  });
});

describe('сборка (решение 9, FR-WG-10)', () => {
  test('файл загрузчика совпадает со сборкой из исходника, текстов и токенов', () => {
    expect(source).toBe(buildWidget());
  });

  test('не больше 15 КБ в сжатом виде', () => {
    expect(gzipSync(source).length).toBeLessThanOrEqual(15 * 1024);
  });

  test('без eval, new Function, innerHTML, встроенных стилей и адреса "*"', () => {
    // Собранный файл: комментарии исходника в нём уже убраны.
    const loader = source;
    for (const forbidden of [/\beval\s*\(/, /new Function/, /innerHTML|outerHTML|insertAdjacentHTML/, /\.style\./, /setAttribute\('style'/, /postMessage\([^)]*'\*'/, /document\.cookie|localStorage|sessionStorage/])
      expect(loader, String(forbidden)).not.toMatch(forbidden);
  });

  test('тексты всех языков подставлены из messages/*.json', () => {
    for (const locale of ['ru', 'uz', 'en']) {
      const messages = JSON.parse(readFileSync(resolve(`messages/${locale}.json`), 'utf8'));
      expect(source).toContain(JSON.stringify(messages.widget.loader.button));
    }
  });
});
