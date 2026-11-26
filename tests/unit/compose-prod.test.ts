import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';
import { parse } from 'yaml';

// Развёртывание по разделам 13.3 и 13.4 ТЗ: Caddy, портал, задачи базы и PostgreSQL (веха M1, проверка main, C2),
// фоновый процесс и ClamAV (веха M2, решение 0028). TEI добавится в своей вехе.
// merge: вторая копия портала описана ссылкой на первую (ключ <<), как это читает docker compose.
const compose = parse(readFileSync('compose.prod.yaml', 'utf8'), { merge: true });
const caddyfile = readFileSync('Caddyfile', 'utf8');
const services = compose.services as Record<string, Record<string, unknown>>;

test('наружу порты публикует только caddy', () => {
  const published = Object.entries(services).filter(([, s]) => s.ports !== undefined).map(([name]) => name);
  expect(published).toEqual(['caddy']);
  expect(services.caddy?.ports).toEqual(['80:80', '443:443']);
});

test('образы сторонних служб закреплены по digest', () => {
  for (const name of ['caddy', 'postgres', 'clamav', 'tei', 'typesense']) expect(String(services[name]?.image), name).toMatch(/@sha256:[0-9a-f]{64}$/);
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
  // Второй том: каталог сегментов журнала для непрерывного архива (решение 0039).
  expect(pg.volumes).toEqual(['pg_data:/var/lib/postgresql', './wal-archive:/wal-archive']);
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
  for (const part of ['{$HUB_DOMAIN} {', 'encode zstd gzip', 'max_size 2MB', 'Strict-Transport-Security "max-age=31536000; includeSubDomains"', '-Server', 'reverse_proxy {$HUB_UPSTREAMS:web:3000}'])
    expect(caddyfile).toContain(part);
});

test('фоновый процесс с теми же ограничениями, что портал: не root, только чтение, писать можно в /tmp', () => {
  const worker = services.worker as Record<string, unknown>;
  // Тот же образ, что у портала и миграций.
  expect(String(worker.image)).toMatch(/^\$\{HUB_IMAGE:\?/);
  expect(worker.command).toEqual(['node', 'worker.mjs']);
  // Ключ Claude API только у фонового процесса (план M5, решение 3): необязательный файл .env.worker, у портала его нет.
  expect(worker.env_file).toEqual([{ path: '.env' }, { path: '.env.worker', required: false }]);
  expect(JSON.stringify(services.web?.env_file)).not.toContain('.env.worker');
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
    // Обновление баз без второй копии в памяти: предел памяти контейнера 2 ГБ (итоговая проверка W0, M8).
    // Параметр есть в этой версии clamd, образ переносит его в clamd.conf (проверено на образе).
    CLAMD_CONF_ConcurrentDatabaseReload: 'no',
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
  for (const name of ['caddy', 'web', 'worker', 'clamav', 'postgres', 'tei', 'typesense']) expect(String(services[name]?.mem_limit ?? ''), name).toMatch(/^\$\{[A-Z_]+:-\d+[mg]\}$/);
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

test('журнал доступа Caddy без секретных заголовков и адресов с токенами (итоговая проверка W0, I1; ТЗ 13.8)', () => {
  // Секрет вебхука Telegram, подпись вебхука почты и Referer (в нём адрес страницы с ?token=) в журнал не пишутся.
  for (const header of ['X-Telegram-Bot-Api-Secret-Token', 'Referer', 'Svix-Signature']) expect(caddyfile).toMatch(new RegExp(`request>headers>${header} delete`));
  // Переадресация может нести токен в адресе (страницы входа по ссылке возвращают ошибку в тот же адрес).
  expect(caddyfile).toMatch(/resp_headers>Location delete/);
});

// Защита контейнеров (аудит 23.11.2026, находка S9; план W1, задача 9).

test('процессы портала работают без привилегий ядра и не могут их получить', () => {
  for (const name of ['web', 'worker', 'migrate', 'bootstrap']) {
    expect(services[name]?.cap_drop, name).toEqual(['ALL']);
    expect(services[name]?.cap_add, name).toBeUndefined();
    expect(services[name]?.security_opt, name).toEqual(['no-new-privileges:true']);
  }
});

test('Caddy оставляет себе только право занять порты 80 и 443', () => {
  expect(services.caddy?.cap_drop).toEqual(['ALL']);
  expect(services.caddy?.cap_add).toEqual(['NET_BIND_SERVICE']);
  expect(services.caddy?.security_opt).toEqual(['no-new-privileges:true']);
});

test('сторонние службы не получают новых привилегий, привилегированных контейнеров нет', () => {
  for (const [name, service] of Object.entries(services)) {
    expect(service.security_opt, name).toEqual(['no-new-privileges:true']);
    expect(service.privileged, name).toBeUndefined();
    expect(service.network_mode, name).toBeUndefined();
  }
});

test('сети разделены: антивирус не достаёт до базы и портала, Caddy не достаёт до базы, у базы нет выхода наружу', () => {
  const nets = (name: string) => [...((services[name]?.networks as string[] | undefined) ?? [])].sort();
  expect(nets('caddy')).toEqual(['edge']);
  expect(nets('web')).toEqual(['data', 'edge', 'embed', 'search']);
  expect(nets('worker')).toEqual(['data', 'embed', 'scan', 'search']);
  // Typesense во внутренней сети с порталом и фоновым процессом, без базы и без выхода наружу (план W6, решение 16).
  expect(nets('typesense')).toEqual(['search']);
  // TEI во внутренней сети без выхода наружу и без базы; веса качает отдельная служба по команде (план M5, решение 6).
  expect(nets('tei')).toEqual(['embed']);
  expect(nets('tei-download')).toEqual(['models']);
  expect(services['tei-download']?.profiles).toEqual(['tools']);
  expect(nets('clamav')).toEqual(['scan']);
  expect(nets('postgres')).toEqual(['data']);
  expect(nets('migrate')).toEqual(['data']);
  expect(nets('bootstrap')).toEqual(['data']);
  // Каждая служба названа в какой-то сети: общей сети по умолчанию нет.
  for (const [name, service] of Object.entries(services)) expect(service.networks, name).toBeDefined();
  const networks = compose.networks as Record<string, { internal?: boolean } | null>;
  expect(Object.keys(networks).sort()).toEqual(['data', 'edge', 'embed', 'models', 'scan', 'search']);
  expect(networks.data?.internal).toBe(true);
  expect(networks.embed?.internal).toBe(true);
  expect(networks.search?.internal).toBe(true);
  // Антивирус обновляет базы подписей из интернета, порталу и фоновому процессу нужны почта, Telegram и хранилище.
  expect(networks.scan?.internal ?? false).toBe(false);
  expect(networks.edge?.internal ?? false).toBe(false);
});

test('памятка запуска закрепляет образ портала по идентификатору, а не по метке', () => {
  const launch = readFileSync('docs/runbooks/launch.md', 'utf8');
  expect(launch).toContain("docker image inspect --format '{{.Id}}' smartup-hub:<версия>");
  expect(launch).toMatch(/export HUB_IMAGE=sha256:<идентификатор>/);
});

// Запуск в двух копиях (аудит 23.11.2026, находка O6; план W2, задача 12).

test('Caddy проксирует на список адресов портала, проверяет готовность и повторяет запрос на другой копии', () => {
  expect(caddyfile).toMatch(/reverse_proxy \{\$HUB_UPSTREAMS:web:3000\} \{/);
  expect(caddyfile).toContain('health_uri /api/ready');
  expect(caddyfile).toMatch(/health_interval \d+s/);
  // Копия, которая не отвечает, снимается; запрос за это время уходит на другую.
  expect(caddyfile).toMatch(/lb_try_duration \d+s/);
  expect(caddyfile).toMatch(/fail_duration \d+s/);
  expect((services.caddy?.environment as Record<string, string>).HUB_UPSTREAMS).toBe('${HUB_UPSTREAMS:-web:3000}');
});

test('вторая копия портала описана теми же настройками и запускается только по своему профилю', () => {
  const web = services.web as Record<string, unknown>;
  const web2 = services.web2 as Record<string, unknown>;
  expect(web2.profiles).toEqual(['replica']);
  for (const key of ['image', 'command', 'env_file', 'user', 'read_only', 'mem_limit', 'stop_grace_period', 'tmpfs', 'cap_drop', 'security_opt', 'networks', 'healthcheck', 'restart'])
    expect(web2[key], key).toEqual(web[key]);
  expect(web2.ports).toBeUndefined();
});

test('соединения с базой при двух копиях портала укладываются в 60% предела', async () => {
  const { connectionsFor } = await import('@/db/pool-size');
  const pg = services.postgres as { command: string[] };
  const max = Number(pg.command.find((part) => part.startsWith('max_connections='))?.split('=')[1]);
  expect(max).toBe(100);
  // Одна копия с настройками по умолчанию: портал и фоновый процесс.
  expect(connectionsFor({ webReplicas: 1, workers: 1, poolMax: 10 })).toBeLessThanOrEqual(max * 0.6);
  // Две копии с настройками по умолчанию не укладываются: в памятке запуска для двух копий задан DB_POOL_MAX=6.
  expect(connectionsFor({ webReplicas: 2, workers: 1, poolMax: 10 })).toBeGreaterThan(max * 0.6);
  expect(connectionsFor({ webReplicas: 2, workers: 1, poolMax: 6 })).toBeLessThanOrEqual(max * 0.6);
  const launch = readFileSync('docs/runbooks/launch.md', 'utf8');
  expect(launch).toContain('DB_POOL_MAX=6');
  expect(launch).toContain('HUB_UPSTREAMS="web:3000 web2:3000"');
});

test('Caddy отвечает 405 на TRACE и TRACK до портала (ASVS 5.0.0, требование 13.4.4; план подготовки M9, задача 1)', () => {
  // Next.js отвечает на TRACE ошибкой 500: метод не поддерживается, но ответ выглядит как сбой.
  expect(caddyfile).toMatch(/@trace method TRACE TRACK\n\s*respond @trace 405/);
  // Отказ стоит выше проксирования: запрос до портала не доходит.
  expect(caddyfile.indexOf('respond @trace 405')).toBeLessThan(caddyfile.indexOf('reverse_proxy'));
});

test('Caddy не затирает Referrer-Policy страниц виджета: своё значение только для ответа без него (ASVS 5.0.0, требование 3.4.5)', () => {
  // Страницы виджета и мобильного приложения отвечают no-referrer (src/security/csp.ts, план M6). Заголовок без "?"
  // Caddy ставил поверх ответа портала (проверено на Caddy 2.10.2 при подготовке M9).
  expect(caddyfile).toMatch(/\?Referrer-Policy "strict-origin-when-cross-origin"/);
  expect(caddyfile).not.toMatch(/^\s*Referrer-Policy /m);
});

test('Typesense (план W6, решения 3, 13, 16): образ 30.2 по digest, журналы запросов выключены, главный ключ секретом', () => {
  const ts = services.typesense as Record<string, unknown>;
  expect(ts.image).toBe('typesense/typesense:30.2@sha256:610f2d34b1f93d00762869da2c67736775e5798d19a2c8b91b014b8a0cc1e110');
  expect(ts.ports).toBeUndefined();
  expect(ts.read_only).toBe(true);
  expect(ts.cap_drop).toEqual(['ALL']);
  expect(ts.security_opt).toEqual(['no-new-privileges:true']);
  expect(ts.volumes).toEqual(['typesense_data:/data']);
  expect(ts.secrets).toEqual(['typesense_api_key']);
  expect(String(ts.mem_limit)).toBe('${TYPESENSE_MEM_LIMIT:-2560m}');
  // До сервера 16 ГБ служба не запускается сама (ответ владельца 0070, пункт 1).
  expect(ts.profiles).toEqual(['search']);
  const command = (ts.command as string[]).join(' ');
  for (const flag of ['--log-slow-searches-time-ms=-1', '--enable-search-logging=false', '--enable-access-logging=false', '--enable-search-analytics=false', '--memory-used-max-percentage=90'])
    expect(command, flag).toContain(flag);
  // Главный ключ не в окружении и не в аргументах compose: из файла секрета.
  expect(command).toContain('$(cat /run/secrets/typesense_api_key)');
  expect(command).not.toContain('--enable-cors');
  expect(ts.environment).toBeUndefined();
  expect((compose.secrets as Record<string, { file: string }>).typesense_api_key?.file).toBe('./secrets/typesense_api_key');
  expect(Object.keys(compose.volumes as object)).toContain('typesense_data');
});

test('ключ записи индекса только у фонового процесса: у портала только файл .env', () => {
  expect(services.web?.env_file).toEqual(['.env']);
  const files = (services.worker?.env_file as { path: string }[]).map((f) => f.path);
  expect(files).toEqual(['.env', '.env.worker']);
  expect(JSON.stringify(services.web)).not.toContain('TYPESENSE_WRITE_KEY');
});
