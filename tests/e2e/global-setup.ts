import { execFileSync } from 'node:child_process';
import type { FullConfig } from '@playwright/test';
import { dbRows } from './helpers/db';
import { HOST } from './helpers/widget';

// Перед браузерными тестами база должна быть готова: /api/ready проверяет её.
// Сценарий поднимает базу из compose.yaml, создаёт роли и применяет миграции.
export default async function globalSetup(config: FullConfig) {
  execFileSync(process.execPath, ['scripts/dev-up.mjs', '--prepare'], { stdio: 'inherit' });
  // База разработки переживает прогоны: счётчики частоты прошлого прогона (все запросы идут с одного адреса)
  // не должны блокировать этот. В CI база каждый раз новая.
  await dbRows(`delete from hdc_rate_limits`);
  await waitForEmbedOrigins(config.projects[0]?.use.baseURL ?? 'http://localhost:3100');
}

/**
 * Портал стартует раньше подготовки базы и держит адреса встраивания в памяти до 60 секунд (решение 0058). Если он
 * прочитал реестр между записью сервера mock и записью демонстрационной страницы (scripts/dev-up.mjs), тесты виджета
 * получили бы старый frame-ancestors. Ждём, пока заголовок страницы виджета назовёт демонстрационную страницу.
 */
async function waitForEmbedOrigins(baseURL: string): Promise<void> {
  const [mock] = await dbRows<{ embed_key: string }>(`select embed_key from hdu_servers where code = 'mock'`);
  if (!mock) return;
  const deadline = Date.now() + 75_000;
  while (Date.now() < deadline) {
    const response = await fetch(`${baseURL}/ru/embed/report?key=${mock.embed_key}`).catch(() => null);
    if (response?.headers.get('content-security-policy')?.includes(HOST)) return;
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  throw new Error(`Портал не видит адрес ${HOST} в адресах встраивания сервера mock: проверьте scripts/dev-up.mjs --prepare`);
}
