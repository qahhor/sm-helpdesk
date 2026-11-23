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

test('ClamAV не пропускает то, что не может проверить: зашифрованное и сверх пределов (решение 0027, пункт 20)', () => {
  // Образ при каждом запуске переносит CLAMD_CONF_<параметр> в clamd.conf. Без этих параметров архив с паролем
  // и архив сверх пределов проверки антивирус отдаёт как чистые (проверено на образе этой версии).
  expect((services.clamav as { environment?: unknown }).environment).toEqual({
    CLAMD_CONF_AlertEncryptedArchive: 'yes',
    CLAMD_CONF_AlertEncryptedDoc: 'yes',
    CLAMD_CONF_AlertExceedsMax: 'yes',
    // Поток длиннее самого большого вложения (видео 50 МБ), иначе clamd обрывает проверку.
    CLAMD_CONF_StreamMaxLength: '60M',
  });
});

// --- План W0, задачи 5 и 6 (аудит 23.11.2026, находки O3, S3, O1) ---

test('PostgreSQL настроен под сервер: статистика запросов, журнал медленных запросов без значений параметров, память', () => {
  const command = (services.postgres?.command as string[]).join(' ');
  for (const part of [
    'shared_preload_libraries=pg_stat_statements',
    'log_min_duration_statement=250',
    // Значения параметров запроса в журнал базы не пишутся: в них данные клиентов.
    'log_parameter_max_length=0',
    'log_parameter_max_length_on_error=0',
    'log_lock_waits=on',
    'shared_buffers=${PG_SHARED_BUFFERS:-1GB}',
    'effective_cache_size=${PG_EFFECTIVE_CACHE_SIZE:-3GB}',
    'max_connections=100',
  ])
    expect(command).toContain(part);
});

test('у каждой постоянной службы предел памяти: сбой одной не забирает память у базы', () => {
  for (const name of ['caddy', 'web', 'worker', 'clamav', 'postgres']) expect(String(services[name]?.mem_limit ?? ''), name).toMatch(/^\$\{[A-Z_]+:-\d+[mg]\}$/);
});

test('фоновому процессу и порталу хватает времени завершить работу при остановке', () => {
  expect(services.worker?.stop_grace_period).toBe('40s');
  expect(services.web?.stop_grace_period).toBe('20s');
});

test('Caddy пускает только доверенные адреса (Cloudflare): остальным 403, список задаётся переменной', () => {
  expect(caddyfile).toMatch(/@untrusted not remote_ip \{\$TRUSTED_PROXIES\}/);
  expect(caddyfile).toMatch(/respond @untrusted 403/);
  const ranges = String((services.caddy?.environment as Record<string, string>).TRUSTED_PROXIES);
  // По умолчанию адреса Cloudflare; для staging без Cloudflare список меняют в .env.
  for (const range of ['173.245.48.0/20', '104.16.0.0/13', '2606:4700::/32']) expect(ranges).toContain(range);
  expect(ranges.startsWith('${TRUSTED_PROXIES:-')).toBe(true);
});

test('журнал доступа Caddy в JSON, одноразовые значения из адреса вырезаны', () => {
  expect(caddyfile).toMatch(/log \{[\s\S]*output stdout[\s\S]*format filter/);
  for (const name of ['token', 'code', 'state']) expect(caddyfile).toMatch(new RegExp(`replace ${name} REDACTED`));
});
