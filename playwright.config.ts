import { defineConfig } from '@playwright/test';

// Браузерные тесты идут против собранного приложения (pnpm build, затем pnpm start).
// Три ширины экрана: телефон клиента, ноутбук агента и узкое окно, где меню агента сворачивается.
const PORT = 3100;
const baseURL = `http://localhost:${PORT}`;

export default defineConfig({
  testDir: 'tests/e2e',
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL,
    locale: 'ru-RU',
    timezoneId: 'Asia/Tashkent',
  },
  projects: [
    { name: 'phone', use: { browserName: 'chromium', viewport: { width: 360, height: 740 }, hasTouch: true, isMobile: true } },
    { name: 'desktop', use: { browserName: 'chromium', viewport: { width: 1280, height: 800 } } },
    { name: 'narrow', use: { browserName: 'chromium', viewport: { width: 1100, height: 800 } } },
  ],
  webServer: {
    command: 'pnpm start',
    url: `${baseURL}/api/health`,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
    env: {
      PORT: String(PORT),
      HUB_URL: baseURL,
      HUB_DOMAIN: 'localhost',
      HUB_SHOWCASE: '1',
      // Страницы этих тестов к базе не обращаются: адреса нужны только для проверки окружения.
      DATABASE_URL_APP: process.env.DATABASE_URL_APP ?? 'postgres://hub_app:e2e@127.0.0.1:5432/hub',
      DATABASE_URL_AUTH: process.env.DATABASE_URL_AUTH ?? 'postgres://hub_auth:e2e@127.0.0.1:5432/hub',
    },
  },
});
