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
