import { execFileSync } from 'node:child_process';
import { defineConfig } from '@playwright/test';

// Браузерные тесты идут против собранного приложения (pnpm build, затем pnpm start).
// Три ширины экрана: телефон клиента, ноутбук агента и узкое окно, где меню агента сворачивается.
const PORT = 3100;
const baseURL = `http://localhost:${PORT}`;

// База нужна проверке /api/ready. В CI её поднимает сама задача и задаёт адреса.
// На машине разработчика сценарий создаёт .env при первом запуске, поднимает базу из compose.yaml,
// создаёт роли и применяет миграции. Процессы тестов наследуют признак и повторно его не запускают.
if (!process.env.CI) {
  if (!process.env.HUB_E2E_PREPARED) {
    execFileSync(process.execPath, ['scripts/dev-up.mjs', '--prepare'], { stdio: 'inherit' });
    process.env.HUB_E2E_PREPARED = '1';
  }
  process.loadEnvFile('.env');
}
const need = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`Браузерные тесты: не задана переменная ${name}`);
  return value;
};

export default defineConfig({
  testDir: 'tests/e2e',
  // Эталонные снимки лежат в одной папке, без деления по проектам и системам.
  snapshotPathTemplate: 'tests/e2e/__screenshots__/{arg}{ext}',
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
      DATABASE_URL_APP: need('DATABASE_URL_APP'),
      DATABASE_URL_AUTH: need('DATABASE_URL_AUTH'),
    },
  },
});
