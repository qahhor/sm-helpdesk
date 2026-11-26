import { randomBytes } from 'node:crypto';
import { afterAll, afterEach, beforeAll, expect, test } from 'vitest';
import { runCli } from '@/cli/commands';
import type { SystemActor } from '@/db/with-actor';
import { addServer, createContextSecret, getServer, updateWidgetSettings } from '@/modules/hdu/api/servers';
import { readContextServer } from '@/modules/hdu/core/servers';
import { setDnsResolverForTests } from '@/modules/hdu/url-safety';
import { createSecretBox, type SecretBox } from '@/security/secret-box';
import { staffCtx } from './helpers/auth';
import { asActor, pools } from './helpers/db';
import { seedTwoOrgs } from './isolation/fixture';

// Реестр серверов: настройки токена контекста и встраивания виджета (план M6, задача 1; FR-ADM-01, 11.4, FR-WG-09).

const system: SystemActor = { type: 'system', job: 'test' };
const input = {
  code: 'srv-acme',
  name: 'ACME',
  baseUrl: 'https://acme.smartup.example',
  issuer: 'https://id.acme.smartup.example',
  clientId: 'hub',
  clientSecret: 'top-secret-value',
};

// Имена *.example в DNS не разрешаются; адрес "internal.example" разрешается во внутреннюю сеть.
beforeAll(() => setDnsResolverForTests(async (host) => (host.startsWith('internal.') ? ['10.0.0.7'] : ['203.0.113.10'])));
afterAll(() => setDnsResolverForTests(null));

const shared = globalThis as typeof globalThis & { __hubSecretBox?: SecretBox };
const originalBox = shared.__hubSecretBox;
afterEach(() => {
  shared.__hubSecretBox = originalBox;
});

async function admin() {
  const f = await seedTwoOrgs();
  await addServer(system, input);
  return { f, ctx: staffCtx(f.adminStaff) };
}

test('у каждого сервера свой ключ встраивания, издатель по умолчанию равен адресу сервера входа', async () => {
  const { f } = await admin();
  const rows = (await pools.root.query(`select code, embed_key, context_issuer, issuer, context_key_mode from hdu_servers order by code`)).rows;
  expect(rows).toHaveLength(2);
  for (const row of rows) {
    expect(row.embed_key).toMatch(/^[0-9a-f]{32}$/);
    expect(row.context_issuer).toBe(row.issuer);
    // Пока администратор не выбрал режим, виджет с сервером не работает.
    expect(row.context_key_mode).toBeNull();
  }
  expect(rows[0].embed_key).not.toBe(rows[1].embed_key);
  expect(rows.map((r) => r.code).sort()).toEqual([f.server.code, 'srv-acme'].sort());
});

test('режим jwks: адрес ключей проверяется по правилам T16, алгоритмы задаёт режим', async () => {
  const { ctx } = await admin();
  await expect(
    updateWidgetSettings(ctx, { code: 'srv-acme', mode: 'jwks', jwksUrl: 'https://internal.acme.example/jwks', embedOrigins: [] }),
  ).rejects.toMatchObject({ code: 'invalid_input' });
  await expect(updateWidgetSettings(ctx, { code: 'srv-acme', mode: 'jwks', jwksUrl: 'https://169.254.169.254/keys', embedOrigins: [] })).rejects.toMatchObject({
    code: 'invalid_input',
  });
  await expect(updateWidgetSettings(ctx, { code: 'srv-acme', mode: 'jwks', jwksUrl: 'http://acme.smartup.example/jwks', embedOrigins: [] })).rejects.toMatchObject({
    code: 'invalid_input',
  });
  // Режим jwks без адреса ключей не сохраняется.
  await expect(updateWidgetSettings(ctx, { code: 'srv-acme', mode: 'jwks', embedOrigins: [] })).rejects.toMatchObject({ code: 'invalid_input' });
  expect(await updateWidgetSettings(ctx, { code: 'srv-acme', mode: 'jwks', jwksUrl: 'https://id.acme.smartup.example/hub/jwks', embedOrigins: [] })).toEqual({
    secret: null,
  });
  const server = await readContextServer('https://id.acme.smartup.example');
  expect(server).toMatchObject({ code: 'srv-acme', mode: 'jwks', jwksUrl: 'https://id.acme.smartup.example/hub/jwks', algorithms: ['ES256', 'EdDSA', 'RS256'] });
  expect(await getServer(system, 'srv-acme')).toMatchObject({
    widget: { contextKeyMode: 'jwks', contextJwksUrl: 'https://id.acme.smartup.example/hub/jwks', hasContextSecret: false, embedOrigins: [] },
  });
});

test('общий секрет создаёт портал и показывает один раз; в базе он зашифрован, hub_app его не читает', async () => {
  const { ctx } = await admin();
  const { secret } = await updateWidgetSettings(ctx, { code: 'srv-acme', mode: 'secret', embedOrigins: [] });
  expect(secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
  const row = (await pools.root.query(`select context_secret, context_key_mode from hdu_servers where code = 'srv-acme'`)).rows[0];
  expect(row.context_key_mode).toBe('secret');
  expect(row.context_secret).toMatch(/^v1\./);
  expect(row.context_secret).not.toContain(secret);
  // Повторное сохранение того же режима секрет не меняет и не показывает.
  expect(await updateWidgetSettings(ctx, { code: 'srv-acme', mode: 'secret', embedOrigins: [] })).toEqual({ secret: null });
  // Карточка администратора знает только, что секрет задан.
  const details = await getServer(system, 'srv-acme');
  expect(details?.widget).toMatchObject({ contextKeyMode: 'secret', hasContextSecret: true });
  expect(JSON.stringify(details)).not.toContain(secret as string);
  expect(JSON.stringify(details)).not.toContain(row.context_secret);
  // Проверка подписи получает секрет расшифрованным, алгоритм только HS256.
  expect(await readContextServer('https://id.acme.smartup.example')).toMatchObject({ mode: 'secret', secret, algorithms: ['HS256'] });

  // hub_app не читает колонку секрета ни под каким актором.
  for (const actor of [ctx.actor, system])
    await expect(asActor(pools.app, actor, (c) => c.query(`select context_secret from hdu_servers`))).rejects.toThrow(/permission denied/);

  // Новый секрет заменяет прежний и тоже показывается один раз.
  const rotated = await createContextSecret(ctx, 'srv-acme');
  expect(rotated.secret).not.toBe(secret);
  expect(await readContextServer('https://id.acme.smartup.example')).toMatchObject({ secret: rotated.secret });

  const audit = (await pools.root.query(`select action, actor_id, diff from hdc_audit_log where object_id = 'srv-acme' and action <> 'server.added' order by created_on`)).rows;
  expect(audit).toEqual([
    { action: 'server.widget_updated', actor_id: ctx.actor.userId, diff: { changed: ['contextKeyMode', 'contextSecret'] } },
    { action: 'server.context_secret_created', actor_id: ctx.actor.userId, diff: null },
  ]);
  expect(JSON.stringify(audit)).not.toContain(secret as string);
  expect(JSON.stringify(audit)).not.toContain(rotated.secret);
});

test('издатель токена контекста уникален в реестре', async () => {
  const { ctx, f } = await admin();
  await updateWidgetSettings(ctx, { code: 'srv-acme', mode: 'secret', contextIssuer: 'https://acme.smartup.example', embedOrigins: [] });
  await expect(
    updateWidgetSettings(ctx, { code: f.server.code, mode: 'secret', contextIssuer: 'https://acme.smartup.example', embedOrigins: [] }),
  ).rejects.toMatchObject({ code: 'server_taken' });
  // Адрес сервера входа другого сервера свободен, когда тот назвался другим издателем, и снова занят после этого.
  await expect(
    updateWidgetSettings(ctx, { code: f.server.code, mode: 'secret', contextIssuer: 'https://id.acme.smartup.example', embedOrigins: [] }),
  ).resolves.toMatchObject({});
  await expect(
    updateWidgetSettings(ctx, { code: 'srv-acme', mode: 'secret', contextIssuer: 'https://id.acme.smartup.example', embedOrigins: [] }),
  ).rejects.toMatchObject({ code: 'server_taken' });
  await expect(updateWidgetSettings(ctx, { code: 'srv-acme', mode: 'secret', contextIssuer: 'javascript:alert(1)', embedOrigins: [] })).rejects.toMatchObject({
    code: 'invalid_input',
  });
});

test('адреса встраивания: только https, только схема, узел и порт, не больше пяти; http только для localhost при портале на localhost', async () => {
  const { ctx } = await admin();
  for (const bad of [
    ['http://smartup.partner.example'],
    ['https://smartup.partner.example/path'],
    ['https://smartup.partner.example?x=1'],
    ['https://user@smartup.partner.example'],
    ['*'],
    ["https://a.example 'unsafe-inline'"],
    ['http://10.0.0.5:8080'],
    Array.from({ length: 6 }, (_, i) => `https://s${i}.example`),
  ])
    await expect(updateWidgetSettings(ctx, { code: 'srv-acme', mode: null, embedOrigins: bad }), JSON.stringify(bad)).rejects.toMatchObject({
      code: 'invalid_input',
    });
  // Портал в тестах работает на localhost: локальная демонстрационная страница допускается.
  await updateWidgetSettings(ctx, { code: 'srv-acme', mode: null, embedOrigins: ['https://web2.acme.example:8443', 'http://127.0.0.1:3192', 'https://web2.acme.example:8443'] });
  expect((await getServer(system, 'srv-acme'))?.widget.embedOrigins).toEqual(['https://web2.acme.example:8443', 'http://127.0.0.1:3192']);
});

test('настройки виджета меняет только admin со свежим входом', async () => {
  const { f, ctx } = await admin();
  const change = { code: 'srv-acme', mode: 'secret', embedOrigins: [] };
  await expect(updateWidgetSettings(staffCtx(f.care), change)).rejects.toMatchObject({ code: 'forbidden' });
  await expect(updateWidgetSettings(ctx, change, new Date(+ctx.freshAuthAt! + 901e3))).rejects.toMatchObject({ code: 'stale_session' });
  await expect(createContextSecret(ctx, 'srv-acme', new Date(+ctx.freshAuthAt! + 901e3))).rejects.toMatchObject({ code: 'stale_session' });
  await expect(createContextSecret(staffCtx(f.care), 'srv-acme')).rejects.toMatchObject({ code: 'forbidden' });
  await expect(updateWidgetSettings(ctx, { ...change, code: 'nope' })).rejects.toMatchObject({ code: 'not_found' });
  expect((await pools.root.query(`select context_secret from hdu_servers where code = 'srv-acme'`)).rows[0].context_secret).toBeNull();
});

test('отключённый сервер и сервер без режима не дают проверки токена контекста', async () => {
  const { ctx } = await admin();
  expect(await readContextServer('https://id.acme.smartup.example')).toBeNull();
  await updateWidgetSettings(ctx, { code: 'srv-acme', mode: 'secret', embedOrigins: [] });
  expect(await readContextServer('https://id.acme.smartup.example')).not.toBeNull();
  await pools.root.query(`update hdu_servers set state = 'passive' where code = 'srv-acme'`);
  expect(await readContextServer('https://id.acme.smartup.example')).toBeNull();
  expect(await readContextServer('https://unknown.example')).toBeNull();
});

test('secrets:reseal перешифровывает и секрет токена контекста', async () => {
  const oldKey = randomBytes(32);
  const newKey = randomBytes(32);
  shared.__hubSecretBox = createSecretBox(oldKey);
  const { ctx } = await admin();
  const { secret } = await updateWidgetSettings(ctx, { code: 'srv-acme', mode: 'secret', embedOrigins: [] });
  const before = (await pools.root.query(`select context_secret from hdu_servers where code = 'srv-acme'`)).rows[0].context_secret as string;
  shared.__hubSecretBox = createSecretBox(newKey, [oldKey]);
  const lines: string[] = [];
  const io = { env: { ...process.env }, out: (line: string) => void lines.push(line), err: (line: string) => void lines.push(line), readSecret: async () => '' };
  // Набор seedTwoOrgs кладёт сервер с поддельной строкой секрета OAuth: команда называет его и завершается с кодом 1.
  await runCli(['secrets:reseal'], io);
  const after = (await pools.root.query(`select context_secret from hdu_servers where code = 'srv-acme'`)).rows[0].context_secret as string;
  expect(after).not.toBe(before);
  expect(lines.join('\n')).not.toContain(secret as string);
  // Прежний ключ убран: секрет открывается текущим.
  shared.__hubSecretBox = createSecretBox(newKey);
  expect(await readContextServer('https://id.acme.smartup.example')).toMatchObject({ secret });
});

test('использованные токены контекста: пишет и читает только система, удаляются только строки с вышедшим сроком', async () => {
  const { f } = await admin();
  const insert = (expires: string) =>
    `insert into hdu_context_token_uses (server_id, jti, expires_on) values ('${f.server.serverId}', 'j-' || random()::text, now() + interval '${expires}')`;
  for (const actor of [f.aAdmin.actor, f.adminStaff.actor]) {
    await expect(asActor(pools.auth, actor, (c) => c.query(insert('5 minutes')))).rejects.toThrow(/row-level security/);
    await expect(asActor(pools.app, actor, (c) => c.query('select 1 from hdu_context_token_uses'))).rejects.toThrow(/permission denied/);
  }
  await asActor(pools.auth, system, (c) => c.query(insert('5 minutes')));
  await asActor(pools.auth, system, (c) => c.query(insert('-1 minute')));
  for (const actor of [f.aAdmin.actor, f.adminStaff.actor])
    expect((await asActor(pools.auth, actor, (c) => c.query('select 1 from hdu_context_token_uses'))).rowCount).toBe(0);
  await expect(asActor(pools.auth, system, (c) => c.query(`update hdu_context_token_uses set jti = jti`))).rejects.toThrow(/permission denied/);
  // Удаление действующей строки открыло бы повтор токена: политика его не пропускает.
  expect((await asActor(pools.auth, system, (c) => c.query('delete from hdu_context_token_uses'))).rowCount).toBe(1);
  expect((await pools.root.query('select count(*)::int as n from hdu_context_token_uses where expires_on > now()')).rows[0].n).toBe(1);
});
