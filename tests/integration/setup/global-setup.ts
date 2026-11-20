import { randomBytes } from 'node:crypto';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { bootstrap } from '../../../scripts/db/bootstrap.mjs';
import { migrate } from '../../../scripts/db/migrate.mjs';

// Поднимает PostgreSQL в контейнере и готовит базу теми же сценариями, что и настоящие окружения.
// Адреса подключения передаются тестам через переменные окружения.
export default async function setup() {
  const image = process.env.PG_IMAGE ?? 'pgvector/pgvector:pg18';
  const secret = () => randomBytes(18).toString('hex');
  const superuserPassword = secret();

  const container = await new PostgreSqlContainer(image)
    .withUsername('postgres')
    .withPassword(superuserPassword)
    .withDatabase('postgres')
    .start();

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
  });

  await bootstrap();
  await migrate();

  return async () => {
    await container.stop();
  };
}
