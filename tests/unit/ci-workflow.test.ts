import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { expect, test } from 'vitest';
import { parse } from 'yaml';

// Настройка CI готова, но выключена по решению владельца продукта (docs/decisions/0011).
// GitHub запускает только файлы из .github/workflows, поэтому файл лежит рядом, в другой папке.
const wf = parse(readFileSync('.github/workflows-disabled/ci.yml', 'utf8'));
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

test('GitHub Actions выключен: в папке .github/workflows нет ни одного файла', () => {
  const active = existsSync('.github/workflows') ? readdirSync('.github/workflows') : [];
  expect(active).toEqual([]);
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
  expect(dockerfile).toMatch(/^COPY --from=build --chown=1001:1001 \/app\/dist\/hub\.mjs \.\/hub\.mjs$/m);
  expect(pkg.scripts.build).toContain('scripts/build-cli.mjs');
});

test('браузерным тестам в CI заданы ключи портала и записаны ложные серверы Smartup (M1)', () => {
  const env = wf.jobs.e2e.env as Record<string, string>;
  expect(env.HUB_URL).toBe('http://localhost:3100');
  expect(env.BETTER_AUTH_SECRET.length).toBeGreaterThanOrEqual(32);
  expect(Buffer.from(env.ENCRYPTION_KEY, 'base64')).toHaveLength(32);
  expect(env.ENCRYPTION_KEY).not.toBe(env.BETTER_AUTH_SECRET);
  const steps = (wf.jobs.e2e.steps as { run?: string }[]).map((step) => step.run ?? '');
  const migrate = steps.indexOf('pnpm db:migrate');
  const mocks = steps.indexOf('node scripts/dev-up.mjs --mocks-only');
  expect(mocks).toBeGreaterThan(migrate);
  expect(mocks).toBeLessThan(steps.indexOf('pnpm test:e2e'));
});
