import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { ensureEnvFile } from '../../scripts/dev-up.mjs';

const example = [
  '# пример',
  'DATABASE_URL_APP=postgres://hub_app:change-me-app@127.0.0.1:5432/hub',
  'POSTGRES_PASSWORD=change-me-superuser',
  'DATABASE_URL_SUPERUSER=postgres://postgres:change-me-superuser@127.0.0.1:5432/postgres',
  'BETTER_AUTH_SECRET=change-me-session',
  'ENCRYPTION_KEY=change-me-encryption',
  'MAIL_TRANSPORT=console',
  '',
].join('\n');

const read = (file: string) =>
  Object.fromEntries(
    readFileSync(file, 'utf8')
      .split('\n')
      .filter((line) => /^[A-Z_]+=/.test(line))
      .map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]),
  );

function files() {
  const dir = mkdtempSync(join(tmpdir(), 'dev-up-'));
  const exampleFile = join(dir, '.env.example');
  writeFileSync(exampleFile, example);
  return { envFile: join(dir, '.env'), exampleFile };
}

test('новый файл окружения получает случайные секреты нужного вида', () => {
  const f = files();
  expect(ensureEnvFile(f)).toBe(true);
  const env = read(f.envFile);
  expect(env.BETTER_AUTH_SECRET).toMatch(/^[0-9a-f]{36,}$/);
  expect(Buffer.from(env.ENCRYPTION_KEY, 'base64')).toHaveLength(32);
  expect(readFileSync(f.envFile, 'utf8')).not.toContain('change-me');
  // Одна заглушка даёт один пароль: он стоит и в адресе, и в настройке контейнера.
  expect(env.DATABASE_URL_SUPERUSER).toContain(`:${env.POSTGRES_PASSWORD}@`);
});

test('в существующий файл дописываются только недостающие переменные', () => {
  const f = files();
  writeFileSync(f.envFile, 'DATABASE_URL_APP=postgres://hub_app:mine@127.0.0.1:5432/hub\nPOSTGRES_PASSWORD=mine-too\n');
  expect(ensureEnvFile(f)).toBe(true);
  const env = read(f.envFile);
  expect(env.DATABASE_URL_APP).toBe('postgres://hub_app:mine@127.0.0.1:5432/hub');
  expect(env.POSTGRES_PASSWORD).toBe('mine-too');
  expect(Buffer.from(env.ENCRYPTION_KEY, 'base64')).toHaveLength(32);
  expect(env.MAIL_TRANSPORT).toBe('console');
  // Пароль суперпользователя уже задан: адрес с ним собирается из заданного значения, а не из новой случайной строки.
  expect(env.DATABASE_URL_SUPERUSER).toContain(':mine-too@');
});

test('полный файл не меняется', () => {
  const f = files();
  ensureEnvFile(f);
  const before = readFileSync(f.envFile, 'utf8');
  expect(ensureEnvFile(f)).toBe(false);
  expect(readFileSync(f.envFile, 'utf8')).toBe(before);
});
