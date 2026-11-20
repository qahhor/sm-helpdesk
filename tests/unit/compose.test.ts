import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';
import { parse } from 'yaml';

const compose = parse(readFileSync('compose.yaml', 'utf8'));

test('том базы смонтирован туда, где образ PostgreSQL 18 хранит данные', () => {
  const pg = compose.services.postgres;
  expect(pg.volumes).toEqual(['pg_data:/var/lib/postgresql']);
  expect(pg.ports[0]).toMatch(/^127\.0\.0\.1:/);
});

test('образ базы задаётся переменной и по умолчанию это PostgreSQL 18 с pgvector', () => {
  expect(compose.services.postgres.image).toBe('${PG_IMAGE:-pgvector/pgvector:pg18}');
});

test('пароль суперпользователя не записан в файле', () => {
  const password = String(compose.services.postgres.environment.POSTGRES_PASSWORD);
  expect(password).toMatch(/^\$\{POSTGRES_PASSWORD:\?/);
});
