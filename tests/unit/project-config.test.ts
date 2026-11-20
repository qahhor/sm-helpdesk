import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';
import nextConfig from '../../next.config';
import pkg from '../../package.json';

const cfg = nextConfig as Record<string, unknown>;

test('кеш компонентов выключен (ТЗ 9.4, правило 6)', () => {
  expect(cfg.cacheComponents).toBeUndefined();
  expect(cfg.partialPrefetching).toBeUndefined();
});

test('оптимизатор изображений выключен, сборка для контейнера', () => {
  expect(nextConfig.images?.unoptimized).toBe(true);
  expect(nextConfig.output).toBe('standalone');
  expect(nextConfig.poweredByHeader).toBe(false);
});

test('версии не ниже порогов раздела 9.2 ТЗ', () => {
  const p = pkg as unknown as {
    dependencies: Record<string, string>;
    engines?: { node?: string };
    packageManager?: string;
  };
  expect(p.dependencies.next).toBe('16.4.6');
  expect(p.dependencies.react).toBe('19.3.1');
  expect(p.dependencies['react-dom']).toBe('19.3.1');
  expect(p.engines?.node).toBe('>=26 <27');
  expect(p.packageManager).toMatch(/^pnpm@12\./);
  expect(readFileSync('.node-version', 'utf8').trim()).toMatch(/^26\.\d+\.\d+$/);
});

test('все зависимости закреплены точной версией', () => {
  const p = pkg as unknown as Record<'dependencies' | 'devDependencies', Record<string, string>>;
  for (const [name, range] of Object.entries({ ...p.dependencies, ...p.devDependencies }))
    expect(range, name).toMatch(/^\d+\.\d+\.\d+$/);
});

test('пакеты входа закреплены точными версиями', () => {
  const p = pkg as unknown as Record<'dependencies' | 'devDependencies', Record<string, string>>;
  expect(p.dependencies['better-auth']).toBe('1.7.22');
  expect(p.dependencies['@better-auth/sso']).toBe('1.7.22');
  expect(p.dependencies.kysely).toBe('0.29.9');
  expect(p.dependencies.uqr).toBe('0.1.3');
  expect(p.devDependencies['oauth2-mock-server']).toBe('9.3.0');
  expect(p.devDependencies.rolldown).toBe('1.2.19');
});

test('пример окружения называет новые переменные без значений секретов', () => {
  const example = readFileSync('.env.example', 'utf8');
  for (const name of ['BETTER_AUTH_SECRET', 'ENCRYPTION_KEY', 'MAIL_TRANSPORT', 'MAIL_FILE_DIR']) expect(example).toContain(name);
  expect(example).toMatch(/^BETTER_AUTH_SECRET=change-me-[a-z]+$/m);
  expect(example).toMatch(/^ENCRYPTION_KEY=change-me-[a-z]+$/m);
});
