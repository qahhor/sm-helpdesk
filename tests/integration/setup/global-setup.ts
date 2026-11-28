import { randomBytes } from 'node:crypto';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { GenericContainer, type StartedTestContainer, Wait } from 'testcontainers';
import { bootstrap } from '../../../scripts/db/bootstrap.mjs';
import { migrate } from '../../../scripts/db/migrate.mjs';

// Поднимает PostgreSQL в контейнере и готовит базу теми же сценариями, что и настоящие окружения.
// Адреса подключения передаются тестам через переменные окружения.
export default async function setup() {
  const image = process.env.PG_IMAGE ?? 'pgvector/pgvector:pg18';
  const secret = () => randomBytes(18).toString('hex');
  const superuserPassword = secret();

  // Настройки сервера строкой "имя=значение имя=значение" (PG_SETTINGS): замер проекта perf идёт с памятью как в
  // compose.prod.yaml, а не с настройками образа по умолчанию (shared_buffers 128 МБ).
  // autovacuum=off (проверка качества, Q9): тесты планов запросов не должны зависеть от того, успел ли фоновый сбор
  // статистики пройти между вставкой данных и EXPLAIN. Статистику тест собирает сам (analyzeAll в helpers/db.ts).
  const settings = ['autovacuum=off', ...(process.env.PG_SETTINGS ?? '').split(/\s+/).filter(Boolean)].flatMap((setting) => ['-c', setting]);
  const definition = new PostgreSqlContainer(image).withUsername('postgres').withPassword(superuserPassword).withDatabase('postgres');
  const container = await definition.withCommand(['postgres', ...settings]).start();

  const address = `${container.getHost()}:${container.getMappedPort(5432)}`;
  const url = (user: string, password: string, database: string) =>
    `postgres://${user}:${password}@${address}/${database}`;

  Object.assign(process.env, {
    HUB_URL: 'http://localhost:3000',
    HUB_DOMAIN: 'localhost',
    HUB_DB_NAME: 'hub',
    DATABASE_URL_SUPERUSER: url('postgres', superuserPassword, 'postgres'),
    DATABASE_URL_OWNER: url('hub_owner', secret(), 'hub'),
    DATABASE_URL_APP: url('hub_app', secret(), 'hub'),
    DATABASE_URL_AUTH: url('hub_auth', secret(), 'hub'),
    BETTER_AUTH_SECRET: randomBytes(32).toString('hex'),
    ENCRYPTION_KEY: randomBytes(32).toString('base64'),
    // Секрет токена виджета (план M6, решение 16).
    EMBED_TOKEN_SECRET: randomBytes(32).toString('hex'),
    // Письма в тестах складываются в память, наружу ничего не уходит.
    MAIL_TRANSPORT: 'none',
  });

  await bootstrap();
  await migrate();
  const typesense = await startTypesense();

  return async () => {
    await typesense?.stop();
    await container.stop();
  };
}

/**
 * Typesense для договорных тестов поиска (план W6, задача 1): закреплённый образ 30.2, как в compose.prod.yaml.
 * TYPESENSE_IMAGE задаёт зеркало (mirror.gcr.io/typesense/typesense:30.2), TYPESENSE_TESTS=0 выключает. Образ не
 * скачался: тесты поиска на настоящем сервере пропускаются с причиной в TYPESENSE_TEST_SKIP, остальные идут.
 */
async function startTypesense(): Promise<StartedTestContainer | null> {
  if (process.env.TYPESENSE_TESTS === '0') {
    process.env.TYPESENSE_TEST_SKIP = 'TYPESENSE_TESTS=0';
    return null;
  }
  const image = process.env.TYPESENSE_IMAGE ?? 'typesense/typesense:30.2@sha256:610f2d34b1f93d00762869da2c67736775e5798d19a2c8b91b014b8a0cc1e110';
  const masterKey = randomBytes(24).toString('hex');
  try {
    const started = await new GenericContainer(image)
      .withCommand(['--data-dir', '/tmp', `--api-key=${masterKey}`, '--log-slow-searches-time-ms=-1', '--enable-search-logging=false', '--enable-access-logging=false'])
      .withExposedPorts(8108)
      .withWaitStrategy(Wait.forHttp('/health', 8108).forResponsePredicate((body) => body.includes('"ok":true')))
      .withStartupTimeout(120_000)
      .start();
    process.env.TYPESENSE_TEST_URL = `http://${started.getHost()}:${started.getMappedPort(8108)}`;
    process.env.TYPESENSE_TEST_MASTER_KEY = masterKey;
    return started;
  } catch (error) {
    process.env.TYPESENSE_TEST_SKIP = `контейнер ${image} не запущен: ${error instanceof Error ? error.message.slice(0, 200) : 'ошибка'}`;
    console.warn(`Тесты поиска на Typesense пропускаются: ${process.env.TYPESENSE_TEST_SKIP}`);
    return null;
  }
}
