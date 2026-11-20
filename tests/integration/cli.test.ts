import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { runCli } from '@/cli/commands';
import { setDnsResolverForTests } from '@/modules/hdu/url-safety';
import { pools } from './helpers/db';

beforeAll(() => setDnsResolverForTests(async () => ['203.0.113.10']));
afterAll(() => setDnsResolverForTests(null));

function fakeIo(env: Record<string, string | undefined> = {}, secret = 'typed-secret-value') {
  const lines: string[] = [];
  const errors: string[] = [];
  return {
    lines,
    errors,
    io: {
      env: { ...process.env, ...env },
      out: (line: string) => void lines.push(line),
      err: (line: string) => void errors.push(line),
      readSecret: async () => secret,
    },
  };
}

test('staff:create печатает одноразовую ссылку и пишет аудит от системы', async () => {
  const { io, lines } = fakeIo();
  expect(await runCli(['staff:create', '--email', 'first@smartup.example', '--name', 'Первый', '--role', 'admin'], io)).toBe(0);
  const link = lines.find((l) => l.includes('/ru/staff/setup?token='));
  expect(link).toContain(`${process.env.HUB_URL}/ru/staff/setup?token=`);
  expect(link).toMatch(/token=[\w-]{43}$/);
  expect((await pools.root.query(`select actor_type, actor_id from hdc_audit_log where action = 'staff.invited'`)).rows).toEqual([
    { actor_type: 'system', actor_id: null },
  ]);
  // Токен ссылки нигде, кроме вывода команды, не остаётся.
  const token = (link ?? '').split('token=')[1] ?? '';
  expect(JSON.stringify((await pools.root.query('select * from hdu_invitations')).rows)).not.toContain(token);
});

test('staff:reset для незнакомого адреса завершается с ошибкой и кодом 1', async () => {
  const { io, errors } = fakeIo();
  expect(await runCli(['staff:reset', '--email', 'nobody@smartup.example'], io)).toBe(1);
  expect(errors.join('\n')).toContain('не найден');
});

test('server:add берёт секрет из переменной окружения или спрашивает его, server:list его не показывает', async () => {
  const fromEnv = fakeIo({ HUB_OAUTH_CLIENT_SECRET: 'env-secret-value' });
  expect(
    await runCli(
      ['server:add', '--code', 'cloud', '--name', 'Облако', '--base-url', 'https://cloud.smartup.example', '--issuer', 'https://id.smartup.example', '--client-id', 'hub', '--default'],
      fromEnv.io,
    ),
  ).toBe(0);
  expect(fromEnv.lines.join('\n')).toContain('/api/auth/sso/callback/cloud');
  const typed = fakeIo({ HUB_OAUTH_CLIENT_SECRET: undefined });
  expect(
    await runCli(
      ['server:add', '--code', 'srv-b', '--name', 'B', '--base-url', 'https://b.smartup.example', '--issuer', 'https://b.smartup.example', '--client-id', 'hub', '--role-map', '{"director":"client_admin"}'],
      typed.io,
    ),
  ).toBe(0);
  const list = fakeIo();
  expect(await runCli(['server:list'], list.io)).toBe(0);
  const text = list.lines.join('\n');
  expect(text).toMatch(/cloud.*по умолчанию/);
  expect(text).toContain('srv-b');
  expect(text).not.toMatch(/env-secret-value|typed-secret-value/);
  expect((await pools.root.query(`select role_map from hdu_servers where code = 'srv-b'`)).rows[0].role_map).toEqual({ director: 'client_admin' });
});

test('неверный адрес сервера и неверное соответствие ролей дают понятную ошибку', async () => {
  const bad = fakeIo({ HUB_OAUTH_CLIENT_SECRET: 's' });
  expect(
    await runCli(['server:add', '--code', 'x', '--name', 'X', '--base-url', 'https://10.0.0.1', '--issuer', 'https://x.example', '--client-id', 'hub'], bad.io),
  ).toBe(1);
  expect(bad.errors.join('\n')).toContain('Проверьте');
  const map = fakeIo({ HUB_OAUTH_CLIENT_SECRET: 's' });
  expect(
    await runCli(
      ['server:add', '--code', 'x', '--name', 'X', '--base-url', 'https://x.example', '--issuer', 'https://x.example', '--client-id', 'hub', '--role-map', 'не json'],
      map.io,
    ),
  ).toBe(2);
});

test('server:disable отключает сервер', async () => {
  const add = fakeIo({ HUB_OAUTH_CLIENT_SECRET: 's' });
  await runCli(['server:add', '--code', 'off', '--name', 'Off', '--base-url', 'https://off.example', '--issuer', 'https://off.example', '--client-id', 'hub'], add.io);
  expect(await runCli(['server:disable', '--code', 'off'], fakeIo().io)).toBe(0);
  expect((await pools.root.query(`select state from hdu_servers where code = 'off'`)).rows[0].state).toBe('passive');
});

test('собранный файл запускается без каталога node_modules и не содержит библиотеку входа', async () => {
  execFileSync(process.execPath, ['scripts/build-cli.mjs'], { stdio: 'pipe' });
  const dir = mkdtempSync(join(tmpdir(), 'hub-cli-'));
  cpSync('dist/hub.mjs', join(dir, 'hub.mjs'));
  const out = execFileSync(process.execPath, ['hub.mjs', '--help'], { cwd: dir, encoding: 'utf8' });
  for (const name of ['staff:create', 'staff:reset', 'server:add', 'server:list', 'server:disable']) expect(out).toContain(name);
  expect(readFileSync('dist/hub.mjs', 'utf8')).not.toMatch(/better-call|@better-auth|better-auth\/crypto/);
}, 120_000);
