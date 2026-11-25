import { expect, type Frame, type Page } from '@playwright/test';
import { uniqueSub } from './client';
import { dbRows } from './db';

// Виджет в браузерных тестах (план M6, задачи 5-7). Страница хозяина имитирует Smartup Web: подключает загрузчик
// /widget/v1/hub-widget.js и берёт токен контекста у ложного сервера mock (scripts/mock-oidc.mjs, POST /context-token).
//
// Адрес страницы хозяина: http://localhost:3190, начало base_url ложного сервера mock. Оно разрешено встраивать
// страницы виджета всегда (решение 6), отдельная запись embed_origins не нужна. Сервер на этом порту уже есть (mock),
// саму страницу отдаёт перехват Playwright (page.route), отдельный процесс и порт не нужны. Демонстрационная
// страница на своём порту появится в задаче 9.

export const HUB = 'http://localhost:3100';

/**
 * Запуск браузера для тестов с хозяином. Страницу хозяина отдаёт перехват Playwright, и Chromium считает её адрес
 * публичным: запрос загрузчика с localhost он закрыл бы проверкой доступа к локальной сети (Local Network Access).
 * У настоящих Smartup Web и портала оба адреса публичные, проверки нет. Остальные флаги как в playwright.config.ts.
 */
export const WIDGET_LAUNCH = { args: ['--font-render-hinting=none', '--disable-lcd-text', '--disable-features=LocalNetworkAccessChecks,BlockInsecurePrivateNetworkRequests'] };
export const HOST = 'http://localhost:3190';
const HOST_PAGE = `${HOST}/__widget-host.html`;

/** Ложный сервер mock проверяет токен контекста ключами /context-jwks.json (режим jwks). Повторный вызов безопасен. */
export async function useMockContextKeys(): Promise<string> {
  const rows = await dbRows<{ embed_key: string }>(
    `update hdu_servers set context_key_mode = 'jwks', context_jwks_url = $1 where code = 'mock' returning embed_key`,
    [`${HOST}/context-jwks.json`],
  );
  const key = rows[0]?.embed_key;
  if (!key) throw new Error('Ложный сервер mock не записан в реестр: scripts/dev-up.mjs --prepare');
  return key;
}

/** Новый человек Smartup в ACME Trade на каждый тест: пределы частоты считаются по пользователю. */
export function widgetPersona(): Record<string, string> {
  return { sub: uniqueSub(), name: 'Виджет Тестов', company_id: '501', company_name: 'ACME Trade' };
}

type HostOptions = { key: string; persona: Record<string, string>; locale?: string; hints?: Record<string, string>; theme?: 'light' | 'dark'; platform?: string };

/** Адрес выпуска токена контекста ложным сервером для персоны. */
export function contextTokenUrl(persona: Record<string, string>, platform = 'web'): string {
  const query = new URLSearchParams({ persona: 'custom', platform });
  for (const [field, value] of Object.entries(persona)) query.set(`claim_${field}`, value);
  return `${HOST}/context-token?${query}`;
}

/** Открывает страницу хозяина с загрузчиком. Возвращает её; виджет открывает SmartupHub.open() или reportError. */
export async function openHost(page: Page, opts: HostOptions): Promise<void> {
  const config = {
    hubUrl: HUB,
    embedKey: opts.key,
    locale: opts.locale ?? 'ru',
    theme: opts.theme ?? 'light',
    tokenUrl: contextTokenUrl(opts.persona, opts.platform),
    hints: opts.hints ?? {},
  };
  await page.route(HOST_PAGE, (route) =>
    route.fulfill({
      contentType: 'text/html; charset=utf-8',
      body: `<!doctype html><html lang="ru"><head><meta charset="utf-8"><title>Smartup Web</title></head><body>
<h1>Smartup Web</h1><button id="focus-me">Заказы</button>
<script src="${HUB}/widget/v1/hub-widget.js"></script>
<script>
  const config = ${JSON.stringify(config)};
  window.__created = [];
  window.__tokens = 0;
  window.SmartupHub.init({
    hubUrl: config.hubUrl, embedKey: config.embedKey, locale: config.locale, theme: config.theme,
    getContextToken: () => { window.__tokens += 1; return fetch(config.tokenUrl, { method: 'POST' }).then((r) => r.json()).then((r) => r.token); },
    getHints: () => config.hints,
    onTicketCreated: (number) => window.__created.push(number),
  });
</script></body></html>`,
    }),
  );
  await page.goto(HOST_PAGE);
}

/** Фрейм страницы виджета. Он лежит в закрытом Shadow DOM загрузчика: находим его среди фреймов страницы. */
export async function widgetFrame(page: Page, path = '/embed/'): Promise<Frame> {
  let found: Frame | undefined;
  await expect.poll(() => (found = page.frames().find((frame) => frame.url().includes(path))) !== undefined).toBe(true);
  return found as Frame;
}
