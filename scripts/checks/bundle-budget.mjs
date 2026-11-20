// Бюджет скриптов первого экрана (ТЗ, раздел 8.9): главная кабинета клиента на телефоне
// загружает не больше 170 КБ скриптов в сжатом виде.
//
// Запуск: pnpm budget (после pnpm build). Сценарий сам поднимает собранное приложение,
// открывает /ru в браузере с экраном телефона и складывает размер ответов со скриптами.
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';

export const BUDGET_BYTES = 170 * 1024;

/**
 * Сумма сжатого размера скриптов. Повторные загрузки одного адреса считаются один раз.
 * @param {{ url: string; resourceType: string; encodedBytes: number }[]} responses
 * @returns {number}
 */
export function sumScriptBytes(responses) {
  /** @type {Map<string, number>} */
  const scripts = new Map();
  for (const response of responses)
    if (response.resourceType === 'script') scripts.set(response.url, response.encodedBytes);
  return [...scripts.values()].reduce((sum, bytes) => sum + bytes, 0);
}

const PORT = process.env.BUDGET_PORT ?? '3101';
const BASE = `http://127.0.0.1:${PORT}`;

async function waitForServer() {
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      if ((await fetch(`${BASE}/api/health`)).ok) return;
    } catch {
      // сервер ещё не поднялся
    }
    await new Promise((done) => setTimeout(done, 500));
  }
  throw new Error('Приложение не запустилось. Сначала выполните: pnpm build');
}

async function measure() {
  const { chromium } = await import('@playwright/test');
  const browser = await chromium.launch();
  try {
    const context = await browser.newContext({
      viewport: { width: 360, height: 740 },
      isMobile: true,
      hasTouch: true,
      locale: 'ru-RU',
    });
    const page = await context.newPage();
    /** @type {Promise<{ url: string; resourceType: string; encodedBytes: number }>[]} */
    const pending = [];
    page.on('requestfinished', (request) => {
      pending.push(
        request.sizes().then((sizes) => ({
          url: request.url(),
          resourceType: request.resourceType(),
          encodedBytes: sizes.responseBodySize,
        })),
      );
    });
    const response = await page.goto(`${BASE}/ru`, { waitUntil: 'networkidle' });
    // Замер имеет смысл только на настоящей странице: у страницы ошибки скриптов меньше.
    if (response?.status() !== 200 || (await page.locator('main h1').count()) === 0)
      throw new Error(`Страница /ru не открылась (код ответа ${response?.status()}). Замер бюджета отменён.`);
    return await Promise.all(pending);
  } finally {
    await browser.close();
  }
}

if (import.meta.main) {
  const server = spawn(process.execPath, [resolve(import.meta.dirname, '../start-standalone.mjs')], {
    stdio: 'ignore',
    env: {
      ...process.env,
      PORT,
      HUB_URL: `http://localhost:${PORT}`,
      HUB_DOMAIN: 'localhost',
      DATABASE_URL_APP: process.env.DATABASE_URL_APP ?? 'postgres://hub_app:budget@127.0.0.1:5432/hub',
      DATABASE_URL_AUTH: process.env.DATABASE_URL_AUTH ?? 'postgres://hub_auth:budget@127.0.0.1:5432/hub',
    },
  });
  let failed = false;
  try {
    await waitForServer();
    const responses = await measure();
    const total = sumScriptBytes(responses);
    const kb = (/** @type {number} */ bytes) => Math.round(bytes / 1024);
    console.log(`Скрипты первого экрана: ${kb(total)} КБ из ${kb(BUDGET_BYTES)}`);
    if (total > BUDGET_BYTES) {
      failed = true;
      const scripts = responses.filter((r) => r.resourceType === 'script').sort((a, b) => b.encodedBytes - a.encodedBytes);
      for (const script of scripts) console.error(`  ${kb(script.encodedBytes)} КБ  ${new URL(script.url).pathname}`);
      console.error('Бюджет превышен. Уберите лишний клиентский код с первого экрана.');
    }
  } catch (error) {
    failed = true;
    console.error(error instanceof Error ? error.message : error);
  } finally {
    server.kill('SIGTERM');
  }
  process.exit(failed ? 1 : 0);
}
