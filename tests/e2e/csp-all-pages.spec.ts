import { type APIRequestContext, type APIResponse, type Browser, expect, type Page, request, test } from '@playwright/test';
import { CLIENT_STATE } from './helpers/client';
import { CSP_HANDLERS, CSP_PAGES, type CspPage, type CspWho } from './helpers/csp-pages';
import { dbRows } from './helpers/db';
import { storageStateOf } from './helpers/staff';
import { contextTokenUrl, HOST, HUB, openHost, useMockContextKeys, widgetFrame, widgetPersona } from './helpers/widget';

// Политика содержимого на всех страницах (план подготовки M9, задача 2; ТЗ 14.4; ASVS 5.0 V3.4.3). Список страниц и
// обработчиков tests/e2e/helpers/csp-pages.ts сверяет с каталогом приложения pnpm check. Здесь для каждой строки:
// политика действует (заголовок Content-Security-Policy, режима отчётов нет), скрипты только с одноразовым кодом,
// встраивание запрещено везде, кроме страниц виджета с ключом сервера (план M6, задача 3). Затем браузер открывает
// страницы по одной и больше на каждую группу маршрутов в светлой и тёмной теме и ловит нарушения политики.

const NO_ID = '00000000-0000-7000-8000-000000000000';
const STATE: Record<CspWho, string | undefined> = { guest: undefined, client: CLIENT_STATE, admin: storageStateOf('admin') };

test.describe.configure({ mode: 'serial' });
test.beforeEach(({}, info) => {
  test.skip(info.project.name !== 'desktop', 'обход идёт один раз, на ширине ноутбука');
});

let values: Record<string, string> = {};
/** Значения, которых нет в базе: вместо них несуществующие, страница отвечает 404. */
const missing = new Set<string>();

const first = async (sql: string, params: unknown[] = []): Promise<string | undefined> => {
  const rows = await dbRows<{ v: string | number }>(sql, params);
  return rows[0] === undefined ? undefined : String(rows[0].v);
};

test.beforeAll(async ({}, info) => {
  if (info.project.name !== 'desktop') return;
  const embedKey = await useMockContextKeys();
  const acme = await first(`select org_id as v from hdu_organizations where name = 'ACME Trade'`);
  const found = async (name: string, sql: string, fallback: string, params: unknown[] = []): Promise<string> => {
    const value = await first(sql, params);
    if (value === undefined) missing.add(name);
    return value ?? fallback;
  };
  values = {
    embedKey,
    org: acme ?? NO_ID,
    // Обращение организации клиента, которое видят все её участники.
    clientTicket: `SUP-${await found('clientTicket', `select number as v from hdt_tickets where org_id = $1 and visibility = 'org' order by number desc`, '999999999', [acme])}`,
    ticket: `SUP-${await found('ticket', `select number as v from hdt_tickets order by number desc`, '999999999')}`,
    idea: await found('idea', `select number as v from hdi_ideas where status = 'open' and merged_into_id is null order by number desc`, '999999999'),
    problem: await found('problem', `select number as v from hdp_problems order by number desc`, '999999999'),
    solution: await found('solution', `select number as v from hdk_articles order by number desc`, '999999999'),
    // Адрес решения с slug: без него страница перенаправляет на полный адрес.
    helpRef: await found('helpRef', `select article_number || '-' || slug as v from hdk_published where audience = 'clients' and locale = 'ru' order by article_number desc`, '999999999'),
    macro: await found('macro', `select macro_id as v from hdw_macros order by created_on desc`, NO_ID),
    rule: await found('rule', `select rule_id as v from hdw_rules order by created_on desc`, NO_ID),
    webhook: await found('webhook', `select endpoint_id as v from hdw_webhook_endpoints order by created_on desc`, NO_ID),
  };
});

/** Код ответа страницы: 200, свой код строки обхода или 404, если значения для адреса в базе нет. */
const expectedStatus = (page: CspPage): number => page.status ?? ([...page.path.matchAll(/\{(\w+)\}/g)].some((m) => missing.has(m[1] ?? '')) ? 404 : 200);

const fill = (path: string): string =>
  path.replace(/\{(\w+)\}/g, (_, name: string) => {
    const value = values[name];
    if (value === undefined) throw new Error(`csp-pages: нет значения {${name}}`);
    return value;
  });

async function contexts(): Promise<Record<CspWho, APIRequestContext>> {
  const make = (who: CspWho) => request.newContext({ baseURL: HUB, storageState: STATE[who] });
  return { guest: await make('guest'), client: await make('client'), admin: await make('admin') };
}

/** Все заголовки CSP ответа: браузер применяет каждый. */
const cspOf = (response: APIResponse): string[] =>
  response
    .headersArray()
    .filter((h) => h.name.toLowerCase() === 'content-security-policy')
    .map((h) => h.value);

function expectCommon(response: APIResponse, label: string): string {
  const headers = response.headers();
  expect(response.status(), label).toBeLessThan(500);
  // Политика действует, отчётной копии нет ни в одном ответе (решение 2 плана подготовки).
  expect(headers['content-security-policy-report-only'], label).toBeUndefined();
  expect(headers['x-content-type-options'], label).toBe('nosniff');
  // Портал не разрешает чужим сайтам читать ответы (ASVS 5.0.0, требование 3.4.2): заголовков CORS нет нигде.
  expect(headers['access-control-allow-origin'], label).toBeUndefined();
  const csp = cspOf(response).join('\n');
  expect(csp, label).toContain("object-src 'none'");
  expect(csp, label).toContain("base-uri 'none'");
  expect(csp, label).not.toContain('unsafe-inline');
  expect(csp, label).not.toContain('unsafe-eval');
  return csp;
}

test('каждая страница: политика с одноразовым кодом, встраивание только у виджета с ключом', async () => {
  const by = await contexts();
  for (const page of CSP_PAGES) {
    const path = fill(page.path);
    const label = `${page.route} ${path}`;
    const response = await by[page.who].get(path, { maxRedirects: 0 });
    expect(response.status(), label).toBe(expectedStatus(page));
    const csp = expectCommon(response, label);
    expect(csp, label).toMatch(/script-src 'self' 'nonce-[A-Za-z0-9+/=_-]+' https:\/\/challenges\.cloudflare\.com/);
    expect(csp, label).toMatch(/style-src 'self' 'nonce-/);
    expect(csp, label).toContain("form-action 'self'");
    expect(csp, label).toContain('report-uri /api/csp-report');
    // Страница с данными не остаётся в кеше браузера и промежуточных узлов (ASVS 5.0.0, требование 14.3.2).
    if (response.status() !== 307) expect(response.headers()['cache-control'], label).toContain('no-store');
    const ancestors = cspOf(response).map((value) => /frame-ancestors ([^;]+)/.exec(value)?.[1]).filter(Boolean);
    if (page.embedKey) {
      // Страница виджета с ключом сервера mock: только адреса этого сервера, запрета 'none' нет ни в одном заголовке.
      expect(ancestors, label).toEqual([`http://localhost:3190 ${HOST}`]);
    } else {
      expect(ancestors.length, label).toBeGreaterThan(0);
      expect(new Set(ancestors), label).toEqual(new Set(["'none'"]));
    }
  }
  for (const context of Object.values(by)) await context.dispose();
});

test('каждый обработчик: статическая политика запрещает встраивание, режима отчётов нет', async () => {
  const by = await contexts();
  for (const handler of CSP_HANDLERS) {
    const path = fill(handler.path);
    const label = `${handler.route} ${path}`;
    const response = await by[handler.who].get(path, { maxRedirects: 0 });
    expectCommon(response, label);
    const ancestors = cspOf(response).map((value) => /frame-ancestors ([^;]+)/.exec(value)?.[1]).filter(Boolean);
    expect(new Set(ancestors), label).toEqual(new Set(["'none'"]));
  }
  for (const context of Object.values(by)) await context.dispose();
});

/** Ловушка нарушений политики: событие securitypolicyviolation в каждом фрейме страницы и сообщение консоли. */
async function trap(page: Page, violations: string[]): Promise<void> {
  page.on('console', (m) => {
    if (m.text().includes('Content Security Policy')) violations.push(`${page.url()} ${m.text()}`);
  });
  await page.exposeFunction('__cspViolation', (text: string) => void violations.push(text));
  await page.addInitScript(() => {
    document.addEventListener('securitypolicyviolation', (event) => {
      void (window as unknown as { __cspViolation: (text: string) => void }).__cspViolation(`${event.violatedDirective} ${event.blockedURI} ${location.pathname}`);
    });
  });
}

async function walk(browser: Browser, colorScheme: 'light' | 'dark'): Promise<string[]> {
  const violations: string[] = [];
  const pages: Partial<Record<CspWho, Page>> = {};
  const pageOf = async (who: CspWho) => {
    const existing = pages[who];
    if (existing) return existing;
    const context = await browser.newContext({ baseURL: HUB, colorScheme, storageState: STATE[who] });
    const page = await context.newPage();
    await trap(page, violations);
    pages[who] = page;
    return page;
  };
  for (const entry of CSP_PAGES.filter((p) => p.walk)) {
    const page = await pageOf(entry.who);
    let path = fill(entry.path);
    // Страница мобильного приложения без токена контекста показывает только просьбу открыть её из приложения.
    if (entry.route.endsWith('/m/report')) {
      const response = await page.request.post(contextTokenUrl(widgetPersona(), 'android'));
      path = `${path}#ctx=${((await response.json()) as { token: string }).token}`;
    }
    const response = await page.goto(path);
    // Скрипты после загрузки (гидратация, запросы страницы) успевают выполниться: нарушение может случиться и в них.
    await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => undefined);
    // Тема применена: иначе тёмная тема не проверена. Страница "не найдено" идёт без раскладки портала и темы не
    // получает (поведение Next.js при корневой раскладке в сегменте [locale]; записано в отчёте подготовки).
    if (response?.status() === 200) await expect(page.locator('html'), path).toHaveClass(colorScheme === 'dark' ? /dark/ : /^(?!.*\bdark\b)/);
  }
  // Виджет на странице хозяина: страница портала во фрейме чужого сайта.
  const host = await pageOf('guest');
  await openHost(host, { key: values.embedKey ?? '', persona: widgetPersona(), theme: colorScheme });
  await host.evaluate(() => (window as unknown as { SmartupHub: { open: () => void } }).SmartupHub.open());
  const frame = await widgetFrame(host);
  await frame.waitForLoadState('load');
  await expect(frame.locator('html')).toHaveClass(colorScheme === 'dark' ? /dark/ : /^(?!.*\bdark\b)/);
  // Детектор работает: встроенный скрипт без кода запроса блокируется, и нарушение ловится.
  const probe = await pageOf('admin');
  const before = violations.length;
  await probe.evaluate(() => {
    const script = document.createElement('script');
    script.textContent = 'window.__injected = true';
    document.body.append(script);
  });
  await expect.poll(() => violations.length).toBeGreaterThan(before);
  expect(await probe.evaluate(() => (window as unknown as { __injected?: boolean }).__injected)).toBeUndefined();
  for (const page of Object.values(pages)) await page.context().close();
  return violations.slice(0, before);
}

for (const colorScheme of ['light', 'dark'] as const) {
  test(`страницы каждой группы маршрутов не нарушают политику, тема ${colorScheme}`, async ({ browser }) => {
    test.setTimeout(240_000);
    expect(await walk(browser, colorScheme)).toEqual([]);
  });
}
