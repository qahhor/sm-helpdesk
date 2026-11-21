import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';
import { parse } from 'yaml';

// Развёртывание по разделам 13.3 и 13.4 ТЗ: Caddy, портал, задачи базы и PostgreSQL (веха M1, проверка main, C2),
// фоновый процесс и ClamAV (веха M2, решение 0028). TEI добавится в своей вехе.
const compose = parse(readFileSync('compose.prod.yaml', 'utf8'));
const caddyfile = readFileSync('Caddyfile', 'utf8');
const services = compose.services as Record<string, Record<string, unknown>>;

test('наружу порты публикует только caddy', () => {
  const published = Object.entries(services).filter(([, s]) => s.ports !== undefined).map(([name]) => name);
  expect(published).toEqual(['caddy']);
  expect(services.caddy?.ports).toEqual(['80:80', '443:443']);
});

test('образы сторонних служб закреплены по digest', () => {
  for (const name of ['caddy', 'postgres', 'clamav']) expect(String(services[name]?.image), name).toMatch(/@sha256:[0-9a-f]{64}$/);
});

test('портал работает не от root, с файловой системой только для чтения и писать может только во временные каталоги', () => {
  const web = services.web as Record<string, unknown>;
  expect(web.user).toBe('1001:1001');
  expect(web.read_only).toBe(true);
  expect(web.tmpfs).toEqual(['/tmp', '/app/.next/cache']);
  expect(web.command).toEqual(['node', 'server.js']);
  expect((web.healthcheck as { test: string[] }).test).toEqual(['CMD', 'node', 'scripts/healthcheck.mjs']);
});

test('данные базы на томе в /var/lib/postgresql, пароль суперпользователя секретом', () => {
  const pg = services.postgres as Record<string, unknown>;
  expect(pg.volumes).toEqual(['pg_data:/var/lib/postgresql']);
  expect(pg.environment).toEqual({ POSTGRES_PASSWORD_FILE: '/run/secrets/pg_superuser' });
});

test('миграции и начальная настройка базы запускаются отдельно и только по команде', () => {
  for (const name of ['migrate', 'bootstrap']) expect(services[name]?.profiles, name).toEqual(['tools']);
  expect(services.migrate?.command).toEqual(['node', 'scripts/db/migrate.mjs']);
  expect(services.bootstrap?.command).toEqual(['node', 'scripts/db/bootstrap.mjs']);
  // Подключение владельца есть только у миграций (раздел 13.5 ТЗ).
  expect(services.web?.env_file).toEqual(['.env']);
  expect(services.migrate?.env_file).toEqual(['.env.migrate']);
});

test('Caddy по разделу 13.4: сжатие, предел тела, заголовки, без Server, проксирование на портал', () => {
  for (const part of ['{$HUB_DOMAIN} {', 'encode zstd gzip', 'max_size 2MB', 'Strict-Transport-Security "max-age=31536000; includeSubDomains"', '-Server', 'reverse_proxy web:3000'])
    expect(caddyfile).toContain(part);
});

test('фоновый процесс с теми же ограничениями, что портал: не root, только чтение, писать можно в /tmp', () => {
  const worker = services.worker as Record<string, unknown>;
  // Тот же образ, что у портала и миграций.
  expect(String(worker.image)).toMatch(/^\$\{HUB_IMAGE:\?/);
  expect(worker.command).toEqual(['node', 'worker.mjs']);
  expect(worker.env_file).toEqual(['.env']);
  expect(worker.user).toBe('1001:1001');
  expect(worker.read_only).toBe(true);
  expect(worker.tmpfs).toEqual(['/tmp']);
  expect(worker.restart).toBe('unless-stopped');
  expect(worker.depends_on).toMatchObject({ postgres: { condition: 'service_healthy' }, clamav: { condition: 'service_healthy' } });
});

test('ClamAV без портов наружу, базы подписей на томе', () => {
  const clamav = services.clamav as Record<string, unknown>;
  expect(clamav.ports).toBeUndefined();
  expect(String(clamav.image)).toMatch(/^clamav\/clamav:[0-9.]+@sha256:[0-9a-f]{64}$/);
  expect(clamav.volumes).toEqual(['clamav_db:/var/lib/clamav']);
  expect(compose.volumes).toHaveProperty('clamav_db');
});
