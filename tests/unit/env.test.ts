import { expect, test } from 'vitest';
import { EnvError, parseEnv } from '@/env';
import { missingInEnvExample } from '../../scripts/checks/env-example.mjs';

const ok = {
  NODE_ENV: 'test',
  HUB_URL: 'https://hub.example.test',
  HUB_DOMAIN: 'hub.example.test',
  DATABASE_URL_APP: 'postgres://hub_app:app-secret@db:5432/hub',
  DATABASE_URL_AUTH: 'postgres://hub_auth:auth-secret@db:5432/hub',
};

test('полный набор проходит, значения по умолчанию подставлены', () => {
  const e = parseEnv(ok);
  expect(e.HUB_SHOWCASE).toBe('0');
  expect(e.LOG_LEVEL).toBe('info');
  expect(e.HUB_URL).toBe('https://hub.example.test');
});

test('нет обязательной переменной: ошибка называет её', () => {
  const { DATABASE_URL_APP: _omit, ...rest } = ok;
  void _omit;
  expect(() => parseEnv(rest)).toThrowError(/DATABASE_URL_APP/);
});

test('все нарушения собраны в одно сообщение', () => {
  expect(() => parseEnv({ NODE_ENV: 'test' })).toThrowError(
    /^Неверные переменные окружения: .*HUB_URL \(.+\), .*DATABASE_URL_APP \(.+\), .*DATABASE_URL_AUTH \(.+\)/,
  );
});

test('подключение под суперпользователем отклоняется, пароль в сообщение не попадает', () => {
  const bad = { ...ok, DATABASE_URL_APP: 'postgres://postgres:super-secret@db:5432/hub' };
  expect(() => parseEnv(bad)).toThrowError(EnvError);
  try {
    parseEnv(bad);
  } catch (e) {
    expect(String(e)).toMatch(/DATABASE_URL_APP/);
    expect(String(e)).toMatch(/hub_app/);
    expect(String(e)).not.toMatch(/super-secret/);
  }
});

test('роли приложения и аутентификации не взаимозаменяемы', () => {
  expect(() => parseEnv({ ...ok, DATABASE_URL_AUTH: ok.DATABASE_URL_APP })).toThrowError(/DATABASE_URL_AUTH/);
  expect(() => parseEnv({ ...ok, DATABASE_URL_APP: 'postgres://hub_owner:x@db:5432/hub' })).toThrowError(
    /DATABASE_URL_APP/,
  );
});

test('адрес базы не PostgreSQL или с ошибкой отклоняется без утечки значения', () => {
  for (const value of ['mysql://hub_app:top-secret@db/hub', 'not a url top-secret']) {
    try {
      parseEnv({ ...ok, DATABASE_URL_APP: value });
      expect.unreachable('ожидалась ошибка');
    } catch (e) {
      expect(e).toBeInstanceOf(EnvError);
      expect(String(e)).toMatch(/DATABASE_URL_APP/);
      expect(String(e)).not.toMatch(/top-secret/);
    }
  }
});

test('http разрешён только для localhost', () => {
  expect(() => parseEnv({ ...ok, HUB_URL: 'http://hub.example.test' })).toThrowError(/HUB_URL/);
  expect(parseEnv({ ...ok, HUB_URL: 'http://localhost:3000', HUB_DOMAIN: 'localhost' }).HUB_DOMAIN).toBe('localhost');
  expect(parseEnv({ ...ok, HUB_URL: 'http://127.0.0.1:3000', HUB_DOMAIN: '127.0.0.1' }).HUB_URL).toBe(
    'http://127.0.0.1:3000',
  );
});

test('адрес без схемы, с путём и расхождение домена отклоняются', () => {
  expect(() => parseEnv({ ...ok, HUB_URL: 'hub.example.test' })).toThrowError(/HUB_URL/);
  expect(() => parseEnv({ ...ok, HUB_URL: 'https://hub.example.test/portal' })).toThrowError(/HUB_URL/);
  expect(() => parseEnv({ ...ok, HUB_DOMAIN: 'other.example.test' })).toThrowError(/HUB_DOMAIN/);
});

test('косая черта в конце адреса убирается', () => {
  expect(parseEnv({ ...ok, HUB_URL: 'https://hub.example.test/' }).HUB_URL).toBe('https://hub.example.test');
});

test('витрина не включается в production', () => {
  expect(() => parseEnv({ ...ok, NODE_ENV: 'production', HUB_SHOWCASE: '1' })).toThrowError(/HUB_SHOWCASE/);
});

test('витрина включается при разработке и в production на localhost', () => {
  expect(parseEnv({ ...ok, NODE_ENV: 'development', HUB_SHOWCASE: '1' }).HUB_SHOWCASE).toBe('1');
  expect(
    parseEnv({ ...ok, NODE_ENV: 'production', HUB_SHOWCASE: '1', HUB_URL: 'http://localhost:3000', HUB_DOMAIN: 'localhost' })
      .HUB_SHOWCASE,
  ).toBe('1');
});

test('неизвестные значения перечислений отклоняются', () => {
  expect(() => parseEnv({ ...ok, NODE_ENV: 'staging' })).toThrowError(/NODE_ENV/);
  expect(() => parseEnv({ ...ok, LOG_LEVEL: 'verbose' })).toThrowError(/LOG_LEVEL/);
  expect(() => parseEnv({ ...ok, HUB_SHOWCASE: 'true' })).toThrowError(/HUB_SHOWCASE/);
});

test('.env.example содержит каждое имя из схемы', async () => {
  expect(await missingInEnvExample()).toEqual([]);
});
