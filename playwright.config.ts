import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig } from '@playwright/test';

// Браузерные тесты идут против собранного приложения (pnpm build, затем pnpm start).
// Три ширины экрана: телефон клиента, ноутбук агента и узкое окно, где меню агента сворачивается.
const PORT = 3100;
const baseURL = `http://localhost:${PORT}`;
// Каталог писем браузерных тестов. Его же читают помощники тестов.
export const MAIL_DIR = resolve('test-results/mail');
/** Секрет вебхука почты браузерных тестов: whsec_ и 24 байта в base64. */
export const E2E_WEBHOOK_SECRET = `whsec_${Buffer.alloc(24, 7).toString('base64')}`;
const E2E_DB = 'hub_e2e';
/** Тот же адрес подключения, другая база. */
const withDatabase = (url: string, db: string): string => {
  const parsed = new URL(url);
  parsed.pathname = `/${db}`;
  return parsed.toString();
};

// База нужна проверке /api/ready. Адреса лежат в .env, базу из compose.yaml готовит tests/e2e/global-setup.ts.
// Путь один для машины разработчика и для CI: два способа подготовки расходились (решение 0041, пункт 8).
{
  // Здесь создаётся только файл .env, если его нет. Базу поднимает tests/e2e/global-setup.ts:
  // чтение настроек (список тестов, среда разработки) не запускает Docker.
  if (!existsSync('.env')) execFileSync(process.execPath, ['scripts/dev-up.mjs', '--env-only'], { stdio: 'inherit' });
  process.loadEnvFile('.env');
  // Своя база браузерных тестов на том же сервере: тесты не пишут в базу разработки (проверка main, Q7).
  // Переменные наследуют подготовка базы, команда hub, портал и помощники тестов.
  process.env.HUB_DB_NAME = E2E_DB;
  for (const name of ['DATABASE_URL_APP', 'DATABASE_URL_AUTH', 'DATABASE_URL_OWNER']) {
    const value = process.env[name];
    if (value) process.env[name] = withDatabase(value, E2E_DB);
  }
}
const need = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`Браузерные тесты: не задана переменная ${name}`);
  return value;
};

/** Окружение портала и фонового процесса в браузерных тестах. */
const APP_ENV = {
  PORT: String(PORT),
  HUB_URL: baseURL,
  HUB_DOMAIN: 'localhost',
  HUB_SHOWCASE: '1',
  DATABASE_URL_APP: need('DATABASE_URL_APP'),
  DATABASE_URL_AUTH: need('DATABASE_URL_AUTH'),
  BETTER_AUTH_SECRET: need('BETTER_AUTH_SECRET'),
  ENCRYPTION_KEY: need('ENCRYPTION_KEY'),
  // Письма со ссылками входа тесты читают из каталога.
  MAIL_TRANSPORT: 'file',
  MAIL_FILE_DIR: MAIL_DIR,
  // Бот идёт в ложный Telegram. Секрет вебхука тот же, что в tests/e2e/helpers/telegram.ts.
  TELEGRAM_API_URL: 'http://localhost:3192',
  TELEGRAM_BOT_TOKEN: '123456:e2e-telegram-bot-token',
  TELEGRAM_WEBHOOK_SECRET: 'e2e-telegram-webhook-secret-0123456789abcdef',
  // Портал и фоновый процесс запускаются из разных каталогов: путь к файлам задаётся полностью.
  FILE_STORAGE_DIR: resolve('test-results/storage'),
  // Приём писем (план M4, задача 11): вебхук с подписью Svix, домен и секрет адресов ответа. Тот же секрет вебхука
  // в tests/e2e/helpers/inbound.ts, текст письма заглушка почты читает из MAIL_FILE_DIR/inbound.
  RESEND_WEBHOOK_SECRET: E2E_WEBHOOK_SECRET,
  REPLY_DOMAIN: 'reply.e2e.test',
  REPLY_HMAC_SECRET: 'e2e-reply-hmac-secret-0123456789abcdef',
  // Заголовок Authentication-Results, которому верит разбор писем (решение 11 вехи M4): его вписывают тесты.
  INBOUND_AUTHSERV_ID: 'e2e.inbound.test',
  // Секрет токена виджета (план M6, решение 16): страницы виджета меняют на него токен контекста ложного сервера.
  EMBED_TOKEN_SECRET: 'e2e-embed-token-secret-0123456789abcdef',
  // Заглушка модели с заготовленными ответами (план M5, задачи 6 и 7): черновик из обращения и перевод без ключа.
  AI_STUB: '1',
};

export default defineConfig({
  testDir: 'tests/e2e',
  // Эталонные снимки лежат в одной папке, без деления по проектам и системам.
  snapshotPathTemplate: 'tests/e2e/__screenshots__/{arg}{ext}',
  globalSetup: './tests/e2e/global-setup.ts',
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL,
    locale: 'ru-RU',
    timezoneId: 'Asia/Tashkent',
    // Отрисовка букв не должна зависеть от системных настроек шрифтов машины: без хинтинга и без
    // сглаживания по субпикселям. Иначе эталонные снимки витрины расходятся между машинами (решение 0041, пункт 8).
    launchOptions: { args: ['--font-render-hinting=none', '--disable-lcd-text'] },
  },
  projects: [
    // Сотрудники для тестов: приглашение, пароль и второй фактор через интерфейс (tests/e2e/staff.setup.ts).
    { name: 'setup', testMatch: /.*\.setup\.ts$/, use: { browserName: 'chromium', viewport: { width: 1280, height: 800 } } },
    {
      name: 'phone',
      dependencies: ['setup'],
      use: { browserName: 'chromium', viewport: { width: 360, height: 740 }, hasTouch: true, isMobile: true },
    },
    { name: 'desktop', dependencies: ['setup'], use: { browserName: 'chromium', viewport: { width: 1280, height: 800 } } },
    { name: 'narrow', dependencies: ['setup'], use: { browserName: 'chromium', viewport: { width: 1100, height: 800 } } },
  ],
  webServer: [
    // Ложные серверы Smartup для входа клиента (scripts/mock-oidc.mjs).
    {
      command: 'node scripts/mock-oidc.mjs',
      url: 'http://localhost:3190/.well-known/openid-configuration',
      reuseExistingServer: !process.env.CI,
      timeout: 30_000,
    },
    // Ложный Telegram Bot API для привязки и входа из бота (scripts/mock-telegram.mjs).
    {
      command: 'node scripts/mock-telegram.mjs',
      url: 'http://localhost:3192/__sent',
      reuseExistingServer: !process.env.CI,
      timeout: 30_000,
    },
    {
      command: 'pnpm start',
      url: `${baseURL}/api/health`,
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
      env: APP_ENV,
    },
    // Фоновый процесс (решение 0028): проверка вложений заглушкой антивируса, файлы в локальном хранилище.
    // Серверы стартуют до подготовки базы (tests/e2e/global-setup.ts): процесс ждёт схему pg-boss сам,
    // поэтому готовности здесь не ждём.
    {
      command: 'node dist/worker.mjs',
      timeout: 30_000,
      gracefulShutdown: { signal: 'SIGTERM', timeout: 10_000 },
      env: APP_ENV,
    },
  ],
});
