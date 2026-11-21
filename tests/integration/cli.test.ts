import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, test, vi } from 'vitest';
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

test('server:check печатает итог проверки связи, код 1 при найденных проблемах', async () => {
  const add = fakeIo({ HUB_OAUTH_CLIENT_SECRET: 's' });
  await runCli(['server:add', '--code', 'chk', '--name', 'Chk', '--base-url', 'https://chk.example', '--issuer', 'https://id.chk.example', '--client-id', 'hub'], add.io);
  const discovery = {
    issuer: 'https://id.chk.example',
    authorization_endpoint: 'https://id.chk.example/a',
    token_endpoint: 'https://id.chk.example/t',
    userinfo_endpoint: 'https://id.chk.example/u',
    jwks_uri: 'https://id.chk.example/j',
  };
  const spy = vi.spyOn(globalThis, 'fetch');
  spy.mockImplementation(async () => new Response(JSON.stringify(discovery)));
  const bad = fakeIo();
  expect(await runCli(['server:check', '--code', 'chk'], bad.io)).toBe(1);
  expect(bad.lines.join('\n')).toContain('S256');
  spy.mockImplementation(async () => new Response(JSON.stringify({ ...discovery, code_challenge_methods_supported: ['S256'] })));
  const ok = fakeIo();
  expect(await runCli(['server:check', '--code', 'chk'], ok.io)).toBe(0);
  spy.mockRestore();
  expect(ok.lines.join('\n')).toContain('Сервер отвечает');
  expect(await runCli(['server:check', '--code', 'nope'], fakeIo().io)).toBe(1);
});

test('maintenance:cleanup удаляет только просроченные служебные строки (проверка main, Q8)', async () => {
  const user = (await pools.root.query(`insert into auth."user" (name, email, "emailVerified") values ('Ч', 'c@acme.test', true) returning id`)).rows[0].id;
  await pools.root.query(`insert into hdc_rate_limits (code, window_on, hits) values ('old:1', now() - interval '3 days', 1), ('new:1', now(), 1)`);
  await pools.root.query(`insert into hdn_telegram_updates (update_id, received_on) values (1, now() - interval '3 days'), (2, now())`);
  await pools.root.query(
    `insert into auth.session (token, "userId", "expiresAt", "updatedAt")
     values ('t-old', $1, now() - interval '2 days', now()), ('t-new', $1, now() + interval '1 day', now())`,
    [user],
  );
  await pools.root.query(
    `insert into auth.verification (identifier, value, "expiresAt")
     values ('i-old', 'x', now() - interval '2 days'), ('i-new', 'x', now() + interval '1 hour')`,
  );
  const { io, lines } = fakeIo();
  expect(await runCli(['maintenance:cleanup'], io)).toBe(0);
  expect(lines).toEqual(['Удалено просроченных строк: счётчики частоты 1, события Telegram 1, сессии 1, одноразовые значения входа 1, ссылки и коды входа 0.']);
  expect((await pools.root.query(`select code from hdc_rate_limits`)).rows).toEqual([{ code: 'new:1' }]);
  expect((await pools.root.query(`select update_id from hdn_telegram_updates`)).rows).toEqual([{ update_id: '2' }]);
  expect((await pools.root.query(`select token from auth.session`)).rows).toEqual([{ token: 't-new' }]);
  expect((await pools.root.query(`select identifier from auth.verification`)).rows).toEqual([{ identifier: 'i-new' }]);
});

test('ночная очистка удаляет только строки старше суток после срока', async () => {
  const user = (await pools.root.query(`insert into auth."user" (name, email, "emailVerified") values ('Ч', 'night@acme.test', true) returning id`)).rows[0].id;
  const hash = (n: number) => n.toString(16).padStart(64, '0');
  // Срок вышел больше суток назад, меньше суток назад и ещё не вышел.
  const ages = ["now() - interval '25 hours'", "now() - interval '23 hours'", "now() + interval '1 hour'"];
  for (const [i, age] of ages.entries()) {
    await pools.root.query(`insert into hdu_email_tokens (user_id, email, token_hash, expires_on) values ($1, 'night@acme.test', $2, ${age})`, [user, hash(10 + i)]);
    await pools.root.query(`insert into hdu_link_codes (user_id, kind, code_hash, expires_on) values ($1, 'telegram', $2, ${age})`, [user, hash(20 + i)]);
    await pools.root.query(`insert into hdu_login_codes (user_id, channel, code_hash, expires_on) values ($1, 'telegram', $2, ${age})`, [user, hash(30 + i)]);
  }
  const { io, lines } = fakeIo();
  expect(await runCli(['maintenance:cleanup'], io)).toBe(0);
  expect(lines.join('\n')).toMatch(/ссылки и коды входа 3/);
  for (const [table, column] of [
    ['hdu_email_tokens', 'token_hash'],
    ['hdu_link_codes', 'code_hash'],
    ['hdu_login_codes', 'code_hash'],
  ] as const) {
    const left = (await pools.root.query(`select ${column} as h from ${table} where user_id = $1 order by ${column}`, [user])).rows.map((r) => r.h);
    expect(left, table).toHaveLength(2);
  }
});

test('собранный файл запускается без каталога node_modules и не содержит библиотеку входа', async () => {
  execFileSync(process.execPath, ['scripts/build-cli.mjs'], { stdio: 'pipe' });
  const dir = mkdtempSync(join(tmpdir(), 'hub-cli-'));
  cpSync('dist/hub.mjs', join(dir, 'hub.mjs'));
  const out = execFileSync(process.execPath, ['hub.mjs', '--help'], { cwd: dir, encoding: 'utf8' });
  for (const name of ['staff:create', 'staff:reset', 'server:add', 'server:list', 'server:disable', 'server:check']) expect(out).toContain(name);
  expect(readFileSync('dist/hub.mjs', 'utf8')).not.toMatch(/better-call|@better-auth|better-auth\/crypto/);
}, 120_000);

test('modules:import загружает и обновляет справочник, неверный файл отклоняется с номером строки', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hub-modules-'));
  const file = (name: string, content: unknown) => {
    const path = join(dir, name);
    writeFileSync(path, typeof content === 'string' ? content : JSON.stringify(content, null, 2));
    return path;
  };
  await pools.root.query(`insert into hdr_product_modules (code, name) values ('legacy', '{"ru": "Старый модуль"}')`);
  // Справочник меняет только администратор: загрузка идёт от его имени.
  const adminId = (
    await pools.root.query(`insert into auth."user" (name, email, "emailVerified") values ('Админ', 'catalog-admin@smartup.example', true) returning id`)
  ).rows[0].id as string;
  await pools.root.query(`insert into hdu_staff (user_id, role) values ($1, 'admin')`, [adminId]);
  const agentId = (
    await pools.root.query(`insert into auth."user" (name, email, "emailVerified") values ('Агент', 'catalog-agent@smartup.example', true) returning id`)
  ).rows[0].id as string;
  await pools.root.query(`insert into hdu_staff (user_id, role) values ($1, 'agent_l1')`, [agentId]);
  const ADMIN = ['--admin', 'catalog-admin@smartup.example'];
  const first = file('first.json', [
    { code: 'orders', parentCode: null, name: { ru: 'Заказы', uz: 'Buyurtmalar', en: 'Orders' }, screens: [{ code: 'order_new', name: { ru: 'Новый заказ' } }] },
    { code: 'orders.returns', parentCode: 'orders', name: { ru: 'Возвраты' } },
    { code: 'warehouse', parentCode: null, name: { ru: 'Склад' } },
  ]);
  const run = async (args: string[], admin: string[] = ADMIN) => {
    const { io, lines, errors } = fakeIo();
    const code = await runCli([...args, ...admin], io);
    return { code, lines, errors };
  };

  // Без администратора, от сотрудника не admin и от неизвестного адреса справочник не меняется.
  expect((await run(['modules:import', '--file', first], [])).code).toBe(2);
  expect((await run(['modules:import', '--file', first], ['--admin', 'catalog-agent@smartup.example'])).code).toBe(1);
  expect((await run(['modules:import', '--file', first], ['--admin', 'nobody@smartup.example'])).code).toBe(1);
  expect((await pools.root.query(`select count(*)::int as n from hdr_product_modules`)).rows[0].n).toBe(1);
  expect(await run(['modules:import', '--file', first])).toEqual({ code: 0, lines: ['Справочник модулей загружен: добавлено 3, обновлено 0, скрыто 1.'], errors: [] });
  const rows = async () =>
    (
      await pools.root.query(
        `select m.code, p.code as parent, m.name, m.screens, m.state from hdr_product_modules m
           left join hdr_product_modules p on p.module_id = m.parent_id order by m.code`,
      )
    ).rows;
  expect(await rows()).toEqual([
    { code: 'legacy', parent: null, name: { ru: 'Старый модуль' }, screens: [], state: 'passive' },
    { code: 'orders', parent: null, name: { ru: 'Заказы', uz: 'Buyurtmalar', en: 'Orders' }, screens: [{ code: 'order_new', name: { ru: 'Новый заказ' } }], state: 'active' },
    { code: 'orders.returns', parent: 'orders', name: { ru: 'Возвраты' }, screens: [], state: 'active' },
    { code: 'warehouse', parent: null, name: { ru: 'Склад' }, screens: [], state: 'active' },
  ]);
  // Повторная загрузка обновляет по коду: склад пропал из выгрузки и скрыт, возвраты переехали.
  const second = file('second.json', [
    { code: 'orders', parentCode: null, name: { ru: 'Заказы и продажи' } },
    { code: 'orders.returns', parentCode: null, name: { ru: 'Возвраты' } },
  ]);
  expect((await run(['modules:import', '--file', second])).lines).toEqual(['Справочник модулей загружен: добавлено 0, обновлено 2, скрыто 1.']);
  expect((await rows()).map((r) => [r.code, r.parent, r.state])).toEqual([
    ['legacy', null, 'passive'],
    ['orders', null, 'active'],
    ['orders.returns', null, 'active'],
    ['warehouse', null, 'passive'],
  ]);
  // В журнале аудита итог каждой загрузки от системы.
  const audit = await pools.root.query(`select actor_type, actor_id, object_type, diff from hdc_audit_log where action = 'modules.imported' order by created_on`);
  expect(audit.rows).toEqual([
    // Журнал называет администратора и то, что загрузка шла из консоли, а не из экрана рабочего места.
    { actor_type: 'staff', actor_id: adminId, object_type: 'module', diff: { added: 3, updated: 0, passive: 1, source: 'cli' } },
    { actor_type: 'staff', actor_id: adminId, object_type: 'module', diff: { added: 0, updated: 2, passive: 1, source: 'cli' } },
  ]);
  // Неверный файл: номер записи и строки, справочник не меняется.
  const broken = file('broken.json', '[\n  { "code": "orders", "name": { "ru": "Заказы" } },\n  { "code": "crm", "name": { "uz": "Mijozlar" } }\n]\n');
  const refused = await run(['modules:import', '--file', broken]);
  expect(refused.code).toBe(1);
  expect(refused.errors.join('\n')).toMatch(/запись 2, строка 3: name\.ru/);
  const syntax = await run(['modules:import', '--file', file('syntax.json', '[\n  { "code": "orders",\n')]);
  expect(syntax.code).toBe(1);
  expect(syntax.errors.join('\n')).toMatch(/не JSON.*строка \d+/);
  for (const content of [
    [{ code: 'a', name: { ru: 'A' } }, { code: 'a', name: { ru: 'A' } }],
    [{ code: 'a', parentCode: 'missing', name: { ru: 'A' } }],
    [{ code: 'a', parentCode: 'b', name: { ru: 'A' } }, { code: 'b', parentCode: 'a', name: { ru: 'B' } }],
  ])
    expect((await run(['modules:import', '--file', file('bad.json', content)])).code).toBe(1);
  expect((await run(['modules:import', '--file', join(dir, 'нет-такого.json')])).code).toBe(1);
  expect((await rows()).map((r) => [r.code, r.state])).toEqual([
    ['legacy', 'passive'],
    ['orders', 'active'],
    ['orders.returns', 'active'],
    ['warehouse', 'passive'],
  ]);
});
