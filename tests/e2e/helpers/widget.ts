import { type BrowserContext, expect, type Frame, type Page } from '@playwright/test';
import { uniqueSub } from './client';
import { dbRows } from './db';

// Виджет в браузерных тестах (план M6, задачи 5-9). Страница хозяина: демонстрационная страница Smartup Web
// scripts/mock-smartup-host.mjs на адресе http://127.0.0.1:3195 (её запускает webServer в playwright.config.ts).
// Она подключает загрузчик /widget/v1/hub-widget.js и берёт токен контекста у ложного сервера mock
// (scripts/mock-oidc.mjs, POST /context-token). Адрес записан в адреса встраивания сервера mock (scripts/dev-up.mjs).
//
// 127.0.0.1 и localhost это разные сайты: iframe портала на странице хозяина сторонний, как в настоящем Smartup Web.
// Оба адреса локальные, поэтому проверка Local Network Access в Chromium их не закрывает и остаётся включённой
// (решение 0060). Адрес http://127.0.0.1:3196 отдаёт ту же страницу как посторонний сайт: его в списке нет.

export const HUB = 'http://localhost:3100';
export const HOST = 'http://127.0.0.1:3195';
export const FOREIGN = 'http://127.0.0.1:3196';
/** Ложный сервер mock: выпуск токена контекста и его открытые ключи. */
export const ISSUER = 'http://localhost:3190';

/**
 * Куки третьей стороны закрыты, как уже сейчас в Safari и в Chrome с этой настройкой: виджет работает без кук
 * (решение 1), тесты это и проверяют. В Chromium настройка ставится через CDP (Network.setCookieControls): флаг
 * запуска --test-third-party-cookie-phaseout в этой версии куки не закрывает (проверено). WebKit закрывает их сам.
 * Вызывается в test.beforeEach до открытия страницы.
 */
export async function blockThirdPartyCookies({ page, context, browserName }: { page: Page; context: BrowserContext; browserName: string }): Promise<void> {
  if (browserName !== 'chromium') return;
  const session = await context.newCDPSession(page);
  await session.send('Network.enable');
  await session.send('Network.setCookieControls', { enableThirdPartyCookieRestriction: true });
}

/**
 * Ложный сервер mock проверяет токен контекста ключами /context-jwks.json (режим jwks), демонстрационная страница
 * в адресах встраивания. Это же записывает scripts/dev-up.mjs --prepare; повтор страхует от правки реестра другим
 * тестом. Возвращает ключ встраивания.
 */
export async function useMockContextKeys(): Promise<string> {
  const rows = await dbRows<{ embed_key: string }>(
    `update hdu_servers set context_key_mode = 'jwks', context_jwks_url = $1, embed_origins = $2 where code = 'mock' returning embed_key`,
    [`${ISSUER}/context-jwks.json`, [HOST]],
  );
  const key = rows[0]?.embed_key;
  if (!key) throw new Error('Ложный сервер mock не записан в реестр: scripts/dev-up.mjs --prepare');
  return key;
}

/** Новый человек Smartup в ACME Trade на каждый тест: пределы частоты считаются по пользователю. */
export function widgetPersona(): Record<string, string> {
  return { sub: uniqueSub(), name: 'Виджет Тестов', company_id: '501', company_name: 'ACME Trade' };
}

type HostOptions = {
  key: string;
  persona: Record<string, string>;
  locale?: string;
  hints?: Record<string, string>;
  theme?: 'light' | 'dark';
  platform?: string;
  /** a: с токеном (по умолчанию), b: без getContextToken, fail: getContextToken с ошибкой. */
  mode?: 'a' | 'b' | 'fail';
  /** Адрес страницы хозяина: демонстрационная страница или посторонний сайт. */
  origin?: string;
};

/** Адрес выпуска токена контекста ложным сервером для персоны. */
export function contextTokenUrl(persona: Record<string, string>, platform = 'web'): string {
  const query = new URLSearchParams({ persona: 'custom', platform });
  for (const [field, value] of Object.entries(persona)) query.set(`claim_${field}`, value);
  return `${ISSUER}/context-token?${query}`;
}

/** Адрес демонстрационной страницы хозяина с настройками теста. */
export function hostUrl(opts: HostOptions): string {
  const query = new URLSearchParams({ key: opts.key, persona: 'custom', locale: opts.locale ?? 'ru', theme: opts.theme ?? 'light', platform: opts.platform ?? 'web', mode: opts.mode ?? 'a' });
  for (const [field, value] of Object.entries(opts.persona)) query.set(`claim_${field}`, value);
  for (const [field, value] of Object.entries(opts.hints ?? {})) query.set(field, value);
  return `${opts.origin ?? HOST}/?${query}`;
}

/** Открывает страницу хозяина с загрузчиком. Виджет открывает SmartupHub.open(), меню "Помощь" или reportError. */
export async function openHost(page: Page, opts: HostOptions): Promise<void> {
  await page.goto(hostUrl(opts));
  await expect.poll(() => page.evaluate(() => typeof (window as unknown as { SmartupHub?: unknown }).SmartupHub)).toBe('object');
}

/** Фрейм страницы виджета. Он лежит в закрытом Shadow DOM загрузчика: находим его среди фреймов страницы. */
export async function widgetFrame(page: Page, path = '/embed/'): Promise<Frame> {
  let found: Frame | undefined;
  await expect.poll(() => (found = page.frames().find((frame) => frame.url().includes(path))) !== undefined).toBe(true);
  return found as Frame;
}
