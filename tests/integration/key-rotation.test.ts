import { randomBytes } from 'node:crypto';
import { afterEach, beforeAll, afterAll, expect, test } from 'vitest';
import { runCli } from '@/cli/commands';
import { listSsoServers } from '@/modules/hdu/core/servers';
import { oncallTelegram } from '@/modules/hdn/core/oncall';
import { setDnsResolverForTests } from '@/modules/hdu/url-safety';
import { createSecretBox, type SecretBox } from '@/security/secret-box';
import { pools } from './helpers/db';

// Замена ключа шифрования (аудит 23.11.2026, находка S6): значения, зашифрованные прежним ключом, читаются,
// пока прежний ключ задан, команда hub secrets:reseal перешифровывает их текущим, после неё прежний ключ не нужен.

const shared = globalThis as typeof globalThis & { __hubSecretBox?: SecretBox };
const original = shared.__hubSecretBox;
const oldKey = randomBytes(32);
const newKey = randomBytes(32);
const TOKEN = '123456789:AAEhBOweik6ad9r_QXMENQjcrGbqCr4K-bU';

beforeAll(() => setDnsResolverForTests(async () => ['203.0.113.10']));
afterAll(() => setDnsResolverForTests(null));
afterEach(() => {
  shared.__hubSecretBox = original;
});

function fakeIo(env: Record<string, string | undefined> = {}) {
  const lines: string[] = [];
  const errors: string[] = [];
  return {
    lines,
    errors,
    io: { env: { ...process.env, ...env }, out: (line: string) => void lines.push(line), err: (line: string) => void errors.push(line), readSecret: async () => 'typed' },
  };
}

/** Сервер и токен бота дежурных, зашифрованные прежним ключом. */
async function seedWithOldKey() {
  shared.__hubSecretBox = createSecretBox(oldKey);
  const { io } = fakeIo({ HUB_OAUTH_CLIENT_SECRET: 'client-secret-value' });
  expect(
    await runCli(['server:add', '--code', 'cloud', '--name', 'Облако', '--base-url', 'https://cloud.smartup.example', '--issuer', 'https://id.smartup.example', '--client-id', 'hub', '--default'], io),
  ).toBe(0);
  await pools.root.query(`insert into hdn_channel_secrets (code, sealed) values ('oncall_telegram_bot', $1)`, [
    createSecretBox(oldKey).seal(TOKEN, 'oncall-telegram'),
  ]);
  await pools.root.query(
    `insert into hdc_settings (code, value) values ('notify.oncall_chat_id', '"-1001234567890"'::jsonb), ('notify.oncall_bot', '"own"'::jsonb)
     on conflict (code) do update set value = excluded.value`,
  );
}

test('secrets:reseal перешифровывает секреты серверов и токен бота: после неё прежний ключ не нужен', async () => {
  await seedWithOldKey();
  const before = (await pools.root.query(`select oauth_client_secret as s from hdu_servers where code = 'cloud'`)).rows[0].s as string;

  // Новый ключ без прежнего: вход через сервер и бот дежурных не работают.
  shared.__hubSecretBox = createSecretBox(newKey);
  expect(await listSsoServers()).toEqual([]);
  expect(await oncallTelegram()).toBeNull();

  // Прежний ключ задан: всё читается и до перешифрования.
  shared.__hubSecretBox = createSecretBox(newKey, [oldKey]);
  expect((await listSsoServers()).map((s) => s.clientSecret)).toEqual(['client-secret-value']);

  const run = fakeIo();
  expect(await runCli(['secrets:reseal'], run.io)).toBe(0);
  expect(run.lines.join('\n')).toContain('серверы Smartup 1');
  expect(run.lines.join('\n')).toContain('токены ботов 1');
  expect(run.lines.join('\n') + run.errors.join('\n')).not.toContain('client-secret-value');
  expect(run.lines.join('\n') + run.errors.join('\n')).not.toContain(TOKEN);

  const after = (await pools.root.query(`select oauth_client_secret as s from hdu_servers where code = 'cloud'`)).rows[0].s as string;
  expect(after).not.toBe(before);

  // Прежний ключ убран из окружения.
  shared.__hubSecretBox = createSecretBox(newKey);
  expect((await listSsoServers()).map((s) => s.clientSecret)).toEqual(['client-secret-value']);
  expect(await oncallTelegram()).toEqual({ token: TOKEN, chatId: '-1001234567890' });

  // В журнале по записи на хранилище, от системы, только числа.
  const audit = (await pools.root.query(`select actor_type, object_type, diff from hdc_audit_log where action = 'secrets.resealed' order by object_type`)).rows;
  expect(audit).toEqual([
    { actor_type: 'system', object_type: 'channel_secret', diff: { resealed: 1, failed: 0 } },
    { actor_type: 'system', object_type: 'server', diff: { resealed: 1, failed: 0 } },
  ]);
});

test('secrets:reseal повторно ничего не меняет и не пишет в журнал', async () => {
  await seedWithOldKey();
  shared.__hubSecretBox = createSecretBox(newKey, [oldKey]);
  expect(await runCli(['secrets:reseal'], fakeIo().io)).toBe(0);
  const first = (await pools.root.query(`select oauth_client_secret as s from hdu_servers where code = 'cloud'`)).rows[0].s as string;
  const again = fakeIo();
  expect(await runCli(['secrets:reseal'], again.io)).toBe(0);
  expect(again.lines.join('\n')).toContain('серверы Smartup 0');
  expect((await pools.root.query(`select oauth_client_secret as s from hdu_servers where code = 'cloud'`)).rows[0].s).toBe(first);
  expect((await pools.root.query(`select count(*)::int as n from hdc_audit_log where action = 'secrets.resealed'`)).rows[0].n).toBe(2);
});

test('secrets:reseal называет секрет, который не открывается ни одним ключом, и завершается с кодом 1', async () => {
  await seedWithOldKey();
  // Ни прежний, ни текущий ключ не подходят: значение зашифровано третьим ключом.
  shared.__hubSecretBox = createSecretBox(newKey, [randomBytes(32)]);
  const run = fakeIo();
  expect(await runCli(['secrets:reseal'], run.io)).toBe(1);
  expect(run.errors.join('\n')).toContain('cloud');
  expect(run.errors.join('\n')).toContain('бот дежурных');
  const sealed = (await pools.root.query(`select oauth_client_secret as s from hdu_servers where code = 'cloud'`)).rows[0].s as string;
  expect(run.lines.join('\n') + run.errors.join('\n')).not.toContain(sealed);
  // Строка не тронута: её ещё можно открыть, если прежний ключ найдётся.
  expect(createSecretBox(oldKey).open(sealed, 'hdu_servers:cloud')).toBe('client-secret-value');
});
