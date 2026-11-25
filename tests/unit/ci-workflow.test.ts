import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { expect, test } from 'vitest';
import { parse } from 'yaml';

// Проверки GitHub Actions включены решением владельца от 24.11.2026 (решение 0041, пункт 6; до этого решение 0011).
const wf = parse(readFileSync('.github/workflows/ci.yml', 'utf8'));
const dockerfile = readFileSync('Dockerfile', 'utf8');
const pkg = JSON.parse(readFileSync('package.json', 'utf8'));

test('пять задач и замороженный lock-файл', () => {
  expect(Object.keys(wf.jobs).sort()).toEqual(['check', 'e2e', 'image', 'integration', 'security']);
  expect(JSON.stringify(wf)).toContain('--frozen-lockfile');
});

test('сторонние действия закреплены по хешу', () => {
  const uses = [...JSON.stringify(wf).matchAll(/"uses":"([^"]+)"/g)].map((m) => m[1]);
  expect(uses.length).toBeGreaterThan(0);
  expect(uses.filter((u) => !/@[0-9a-f]{40}$/.test(u))).toEqual([]);
});

test('GitHub Actions включён: настройка лежит в .github/workflows, выключенной копии нет', () => {
  expect(readdirSync('.github/workflows')).toEqual(['ci.yml']);
  expect(existsSync('.github/workflows-disabled')).toBe(false);
});

test('у задач только право чтения репозитория', () => {
  expect(wf.permissions).toEqual({ contents: 'read' });
});

test('запуск на каждую отправку и каждый запрос на слияние', () => {
  // Разборщик YAML читает ключ `on` как логическое значение true.
  const triggers = wf.on ?? wf.true;
  expect(Object.keys(triggers).sort()).toEqual(['pull_request', 'push']);
});

test('контейнер не работает от root', () => {
  expect(dockerfile).toMatch(/^USER 1001:1001$/m);
  expect(dockerfile.trimEnd().split('\n').at(-1)).toBe('CMD ["node", "server.js"]');
});

test('файлы приложения принадлежат root: процесс не может их изменить (проверка main, S10)', () => {
  expect(dockerfile).not.toMatch(/--chown/);
  // Писать процессу можно только в каталог кеша Next.js.
  expect(dockerfile).toMatch(/^RUN mkdir -p \.next\/cache && chown 1001:1001 \.next\/cache$/m);
});

test('базовый образ закреплён по digest (проверка main, S10)', () => {
  expect(dockerfile).toMatch(/^ARG NODE_IMAGE=node:[0-9.]+-slim@sha256:[0-9a-f]{64}$/m);
});

test('образ собран на той же версии Node.js и pnpm, что и проект', () => {
  const node = readFileSync('.node-version', 'utf8').trim();
  expect(dockerfile).toContain(`node:${node}-`);
  expect(dockerfile).toContain(pkg.packageManager);
});

test('телеметрия Next.js выключена в образе и в CI', () => {
  expect(dockerfile).toContain('NEXT_TELEMETRY_DISABLED=1');
  expect(wf.env.NEXT_TELEMETRY_DISABLED).toBe('1');
});

test('в образ не попадают секреты и лишние файлы', () => {
  const ignore = readFileSync('.dockerignore', 'utf8').split('\n');
  for (const line of ['.env*', '.git', 'node_modules', 'tests', 'docs']) expect(ignore).toContain(line);
});

test('команда hub попадает в образ', () => {
  expect(dockerfile).toMatch(/^COPY --from=build \/app\/dist\/hub\.mjs \.\/hub\.mjs$/m);
  expect(pkg.scripts.build).toContain('scripts/build-cli.mjs');
});

test('браузерные тесты в CI готовят окружение так же, как на машине разработчика', () => {
  // Файл .env с одноразовыми значениями создаётся до сборки; базу, роли, миграции и ложные серверы Smartup готовит
  // tests/e2e/global-setup.ts. Отдельной базы и своих ключей у задачи нет: два способа подготовки расходились.
  expect(wf.jobs.e2e.env).toBeUndefined();
  expect(wf.jobs.e2e.services).toBeUndefined();
  const steps = (wf.jobs.e2e.steps as { run?: string }[]).map((step) => step.run ?? '');
  const envFile = steps.indexOf('node scripts/dev-up.mjs --env-only');
  expect(envFile).toBeGreaterThan(-1);
  expect(envFile).toBeLessThan(steps.indexOf('pnpm build'));
  expect(steps.indexOf('pnpm build')).toBeLessThan(steps.indexOf('pnpm test:e2e'));
});

test('замеры бюджета и Lighthouse идут после подготовки базы разработки', () => {
  // Оба замера открывают страницу входа, а она читает базу из .env. Браузерные тесты готовят только свою базу hub_e2e.
  const steps = (wf.jobs.e2e.steps as { run?: string }[]).map((step) => step.run ?? '');
  const prepare = steps.indexOf('node scripts/dev-up.mjs --prepare');
  expect(prepare).toBeGreaterThan(-1);
  expect(prepare).toBeLessThan(steps.indexOf('pnpm budget'));
  expect(steps.indexOf('pnpm budget')).toBeLessThan(steps.indexOf('pnpm lighthouse'));
});

test('оценка Lighthouse считается по медиане трёх замеров с порогами ТЗ', () => {
  const rc = JSON.parse(readFileSync('lighthouserc.json', 'utf8')).ci;
  expect(rc.collect.numberOfRuns).toBe(3);
  expect(rc.assert.assertions['categories:performance']).toEqual(['error', { minScore: 0.85, aggregationMethod: 'median' }]);
  expect(rc.assert.assertions['categories:accessibility']).toEqual(['error', { minScore: 0.95, aggregationMethod: 'median' }]);
});

test('контейнер в задаче image получает все обязательные переменные окружения (итоговая проверка M1)', () => {
  const run = (wf.jobs.image.steps as { run?: string }[]).map((step) => step.run ?? '').join('\n');
  const passed = new Set([...run.matchAll(/--env ([A-Z_]+)=/g)].map((m) => m[1]));
  for (const name of ['HUB_URL', 'HUB_DOMAIN', 'DATABASE_URL_APP', 'DATABASE_URL_AUTH', 'BETTER_AUTH_SECRET', 'ENCRYPTION_KEY'])
    expect(passed, name).toContain(name);
});

test('проект webkit не получает флаги запуска Chromium: WebKit с ними не стартует', async () => {
  process.env.PW_WEBKIT = '1';
  const { default: config } = await import('../../playwright.config');
  const webkit = config.projects?.find((p) => p.name === 'webkit');
  expect(webkit).toBeDefined();
  // Свои параметры проекта заменяют общие целиком: смотрим то, что получит браузер.
  const args = (webkit?.use?.launchOptions ?? config.use?.launchOptions)?.args ?? [];
  expect(args).not.toContain('--font-render-hinting=none');
});
