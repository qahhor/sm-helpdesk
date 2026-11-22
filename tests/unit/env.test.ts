import { expect, test } from 'vitest';
import { clientIpHeaderOf, EnvError, parseEnv } from '@/env';
import { missingInEnvExample } from '../../scripts/checks/env-example.mjs';

const ok = {
  NODE_ENV: 'test',
  HUB_URL: 'https://hub.example.test',
  HUB_DOMAIN: 'hub.example.test',
  DATABASE_URL_APP: 'postgres://hub_app:app-secret@db:5432/hub',
  DATABASE_URL_AUTH: 'postgres://hub_auth:auth-secret@db:5432/hub',
  BETTER_AUTH_SECRET: 'session-secret-of-at-least-32-chars!',
  ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
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

test('параметры в адресе базы не могут подменить пользователя или узел (ревью I1)', () => {
  for (const tail of ['?user=postgres', '?host=evil.example.test', '?password=x', '?options=-c%20role%3Dpostgres'])
    expect(() => parseEnv({ ...ok, DATABASE_URL_APP: ok.DATABASE_URL_APP + tail }), tail).toThrowError(/DATABASE_URL_APP/);
  expect(parseEnv({ ...ok, DATABASE_URL_APP: `${ok.DATABASE_URL_APP}?sslmode=require` }).DATABASE_URL_APP).toContain('sslmode');
});

test('искажённое имя пользователя и адрес без имени базы дают ошибку окружения, а не сбой', () => {
  expect(() => parseEnv({ ...ok, DATABASE_URL_APP: 'postgres://hub%zzapp:pw@db/hub' })).toThrowError(EnvError);
  expect(() => parseEnv({ ...ok, DATABASE_URL_APP: 'postgres://hub_app:pw@db:5432' })).toThrowError(/DATABASE_URL_APP/);
});

// --- Веха M1: секреты входа и режим почты ---

const prod = {
  ...ok,
  NODE_ENV: 'production',
  HUB_URL: 'https://hub.smartup24.com',
  HUB_DOMAIN: 'hub.smartup24.com',
  CLIENT_IP_HEADER: 'cf-connecting-ip',
  // Веха M2: на настоящем адресе в production файлы только в R2.
  FILE_STORAGE: 'r2',
  R2_ENDPOINT: 'https://acct.r2.cloudflarestorage.com',
  R2_BUCKET: 'hub-files',
  R2_ACCESS_KEY_ID: 'key-id',
  R2_SECRET_ACCESS_KEY: 'key-secret',
  // Веха M2: антивирус ClamAV в соседнем контейнере.
  CLAMAV_HOST: 'clamav',
  // Проверка "не робот" на настоящем адресе в production обязательна (защита от перебора).
  TURNSTILE_SITE_KEY: '0x4AAAAAAA-site',
  TURNSTILE_SECRET: '0x4AAAAAAA-secret',
};
const problems = (env: Record<string, string | undefined>) => {
  try {
    parseEnv(env);
    return [];
  } catch (e) {
    return (e as EnvError).problems;
  }
};

test('короткий секрет сессий отклоняется, значение в сообщение не попадает', () => {
  const p = problems({ ...prod, BETTER_AUTH_SECRET: 'short-secret' });
  expect(p.map((x) => x.name)).toEqual(['BETTER_AUTH_SECRET']);
  expect(JSON.stringify(p)).not.toContain('short-secret');
});

test('ключ шифрования обязан быть 32 байта в base64', () => {
  expect(problems({ ...prod, ENCRYPTION_KEY: Buffer.alloc(16).toString('base64') }).map((x) => x.name)).toEqual([
    'ENCRYPTION_KEY',
  ]);
  expect(problems({ ...prod, ENCRYPTION_KEY: 'не base64' }).map((x) => x.name)).toEqual(['ENCRYPTION_KEY']);
  expect(problems({ ...prod, ENCRYPTION_KEY: undefined }).map((x) => x.name)).toEqual(['ENCRYPTION_KEY']);
});

test('секрет сессий и ключ шифрования не совпадают', () => {
  const same = Buffer.alloc(32, 7).toString('base64');
  expect(problems({ ...prod, BETTER_AUTH_SECRET: same, ENCRYPTION_KEY: same }).map((x) => x.name)).toContain(
    'ENCRYPTION_KEY',
  );
});

test('письма в журнал и в файл разрешены только на localhost', () => {
  expect(problems({ ...prod, MAIL_TRANSPORT: 'console' }).map((x) => x.name)).toEqual(['MAIL_TRANSPORT']);
  expect(problems({ ...prod, MAIL_TRANSPORT: 'file', MAIL_FILE_DIR: '/tmp/mail' }).map((x) => x.name)).toEqual([
    'MAIL_TRANSPORT',
  ]);
  const local = { ...prod, HUB_URL: 'http://localhost:3000', HUB_DOMAIN: 'localhost' };
  expect(problems({ ...local, MAIL_TRANSPORT: 'console' })).toEqual([]);
  expect(problems({ ...local, MAIL_TRANSPORT: 'file' }).map((x) => x.name)).toEqual(['MAIL_FILE_DIR']);
  expect(problems({ ...local, MAIL_TRANSPORT: 'file', MAIL_FILE_DIR: '/tmp/mail' })).toEqual([]);
  expect(problems({ ...prod, MAIL_TRANSPORT: 'pigeon' }).map((x) => x.name)).toEqual(['MAIL_TRANSPORT']);
  expect(parseEnv(prod).MAIL_TRANSPORT).toBe('none');
});

test('ключи проверки "не робот" задаются парой', () => {
  expect(problems({ ...ok, TURNSTILE_SITE_KEY: 'k' }).map((x) => x.name)).toEqual(['TURNSTILE_SECRET']);
  expect(problems({ ...ok, TURNSTILE_SECRET: 's' }).map((x) => x.name)).toEqual(['TURNSTILE_SITE_KEY']);
  expect(problems({ ...ok, TURNSTILE_SITE_KEY: 'k', TURNSTILE_SECRET: 's' })).toEqual([]);
  // Пустой ключ после обрезки пробелов: ошибка называет именно его.
  expect(new Set(problems({ ...ok, TURNSTILE_SITE_KEY: ' ', TURNSTILE_SECRET: 's' }).map((x) => x.name))).toEqual(new Set(['TURNSTILE_SITE_KEY']));
});

test('отправка через Resend требует ключ и адрес отправителя и разрешена на боевом узле', () => {
  expect(
    problems({ ...prod, MAIL_TRANSPORT: 'resend' })
      .map((x) => x.name)
      .sort(),
  ).toEqual(['MAIL_FROM', 'RESEND_API_KEY']);
  expect(problems({ ...prod, MAIL_TRANSPORT: 'resend', RESEND_API_KEY: 're_x', MAIL_FROM: 'не адрес' }).map((x) => x.name)).toEqual(['MAIL_FROM']);
  expect(problems({ ...prod, MAIL_TRANSPORT: 'resend', RESEND_API_KEY: 're_x', MAIL_FROM: 'Smartup Hub <hub@mail.smartup24.com>' })).toEqual([]);
  expect(problems({ ...prod, MAIL_TRANSPORT: 'resend', RESEND_API_KEY: 're_x', MAIL_FROM: 'hub@mail.smartup24.com' })).toEqual([]);
  // Письма в журнал и в файлы по-прежнему только на машине разработчика.
  expect(problems({ ...prod, MAIL_TRANSPORT: 'console' }).map((x) => x.name)).toEqual(['MAIL_TRANSPORT']);
});

test('в production на настоящем адресе заголовок адреса клиента задаётся явно (итоговая проверка, I1)', () => {
  expect(problems({ ...prod, CLIENT_IP_HEADER: undefined }).map((p) => p.name)).toEqual(['CLIENT_IP_HEADER']);
  expect(problems({ ...prod, CLIENT_IP_HEADER: 'x-evil' }).map((p) => p.name)).toEqual(['CLIENT_IP_HEADER']);
  expect(parseEnv(prod).CLIENT_IP_HEADER).toBe('cf-connecting-ip');
  // Разработка и тесты на localhost: по умолчанию x-forwarded-for.
  expect(parseEnv({ ...ok, NODE_ENV: 'production', HUB_URL: 'http://localhost:3100', HUB_DOMAIN: 'localhost' }).CLIENT_IP_HEADER).toBeUndefined();
});

test('заголовок адреса посетителя читается той же схемой, что и окружение (проверка main, Q20)', () => {
  expect(clientIpHeaderOf({ CLIENT_IP_HEADER: 'cf-connecting-ip' })).toBe('cf-connecting-ip');
  expect(clientIpHeaderOf({})).toBe('x-forwarded-for');
  expect(() => clientIpHeaderOf({ CLIENT_IP_HEADER: 'x-evil' })).toThrowError(/CLIENT_IP_HEADER/);
});

const r2 = {
  FILE_STORAGE: 'r2',
  R2_ENDPOINT: 'https://acct.r2.cloudflarestorage.com',
  R2_BUCKET: 'hub-files',
  R2_ACCESS_KEY_ID: 'key-id',
  R2_SECRET_ACCESS_KEY: 'key-secret',
};

test('хранилище файлов: local по умолчанию с каталогом .storage, r2 требует адрес, бакет и пару ключей (решение 0027)', () => {
  expect(parseEnv(ok)).toMatchObject({ FILE_STORAGE: 'local', FILE_STORAGE_DIR: '.storage' });
  expect(parseEnv({ ...ok, ...r2 })).toMatchObject(r2);
  for (const name of ['R2_ENDPOINT', 'R2_BUCKET', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY'] as const) {
    const { [name]: _omit, ...rest } = r2;
    void _omit;
    expect(() => parseEnv({ ...ok, ...rest }), name).toThrowError(new RegExp(name));
  }
  expect(() => parseEnv({ ...ok, ...r2, R2_ENDPOINT: 'http://acct.r2.cloudflarestorage.com' })).toThrowError(/R2_ENDPOINT/);
  expect(() => parseEnv({ ...ok, ...r2, R2_ENDPOINT: 'https://acct.r2.cloudflarestorage.com/hub' })).toThrowError(/R2_ENDPOINT/);
  expect(() => parseEnv({ ...ok, ...r2, R2_BUCKET: 'Hub_Files' })).toThrowError(/R2_BUCKET/);
  expect(() => parseEnv({ ...ok, FILE_STORAGE: 's3' })).toThrowError(/FILE_STORAGE/);
  // Ключ доступа в сообщение об ошибке не попадает.
  expect(() => parseEnv({ ...ok, ...r2, R2_BUCKET: '' })).not.toThrowError(/key-secret/);
});

test('в production на настоящем адресе файлы хранятся только в R2, на localhost можно local', () => {
  expect(problems({ ...prod, FILE_STORAGE: 'local' }).map((p) => p.name)).toEqual(['FILE_STORAGE']);
  expect(problems({ ...prod, FILE_STORAGE: undefined }).map((p) => p.name)).toEqual(['FILE_STORAGE']);
  expect(parseEnv(prod).FILE_STORAGE).toBe('r2');
  expect(parseEnv({ ...prod, FILE_STORAGE: 'local', HUB_URL: 'http://localhost:3100', HUB_DOMAIN: 'localhost' }).FILE_STORAGE).toBe('local');
});

test('антивирус: CLAMAV_PORT по умолчанию 3310, на настоящем адресе в production CLAMAV_HOST обязателен (решение 0027)', () => {
  expect(parseEnv(ok)).toMatchObject({ CLAMAV_PORT: 3310 });
  expect(parseEnv(ok).CLAMAV_HOST).toBeUndefined();
  expect(parseEnv({ ...ok, CLAMAV_HOST: 'clamav', CLAMAV_PORT: '3311' })).toMatchObject({ CLAMAV_HOST: 'clamav', CLAMAV_PORT: 3311 });
  expect(() => parseEnv({ ...ok, CLAMAV_PORT: '70000' })).toThrowError(/CLAMAV_PORT/);
  expect(() => parseEnv({ ...ok, CLAMAV_HOST: 'clam av' })).toThrowError(/CLAMAV_HOST/);
  expect(problems({ ...prod, CLAMAV_HOST: undefined }).map((p) => p.name)).toEqual(['CLAMAV_HOST']);
  expect(parseEnv({ ...prod, CLAMAV_HOST: undefined, FILE_STORAGE: 'local', HUB_URL: 'http://localhost:3100', HUB_DOMAIN: 'localhost' }).CLAMAV_HOST).toBeUndefined();
});

test('проверка "не робот": на настоящем адресе в production ключи Turnstile обязательны, локально нет', () => {
  expect(problems({ ...prod, TURNSTILE_SITE_KEY: undefined, TURNSTILE_SECRET: undefined }).map((p) => p.name)).toEqual(['TURNSTILE_SITE_KEY']);
  expect(
    parseEnv({ ...prod, TURNSTILE_SITE_KEY: undefined, TURNSTILE_SECRET: undefined, FILE_STORAGE: 'local', CLAMAV_HOST: undefined, HUB_URL: 'http://localhost:3100', HUB_DOMAIN: 'localhost' })
      .TURNSTILE_SECRET,
  ).toBeUndefined();
  expect(parseEnv(ok).TURNSTILE_SECRET).toBeUndefined();
});
