import { afterAll, beforeAll, expect, test, vi } from 'vitest';
import type { SystemActor } from '@/db/with-actor';
import {
  addServer,
  checkServer,
  disableServer,
  enableServer,
  findLoginServer,
  findServerByAddress,
  listServers,
  serverCallbackUrl,
  updateServer,
} from '@/modules/hdu/api/servers';
import { listSsoServers } from '@/modules/hdu/core/servers';
import { setDnsResolverForTests } from '@/modules/hdu/url-safety';
import { staffCtx } from './helpers/auth';
import { pools } from './helpers/db';
import { spyOutbound } from './helpers/outbound';
import { seedTwoOrgs } from './isolation/fixture';

const system: SystemActor = { type: 'system', job: 'test' };
const input = {
  code: 'srv-acme',
  name: 'ACME',
  baseUrl: 'https://acme.smartup.example',
  issuer: 'https://acme.smartup.example',
  clientId: 'hub',
  clientSecret: 'top-secret-value',
};

// Имена вида *.example в настоящем DNS не разрешаются: тесты подставляют внешний адрес.
beforeAll(() => setDnsResolverForTests(async () => ['203.0.113.10']));
afterAll(() => setDnsResolverForTests(null));

test('секрет сервера лежит в базе зашифрованным и возвращается только библиотеке входа', async () => {
  expect(await addServer(system, input)).toEqual({ code: 'srv-acme' });
  const row = (await pools.root.query(`select * from hdu_servers where code = 'srv-acme'`)).rows[0];
  expect(row.oauth_client_secret).toMatch(/^v1\./);
  expect(JSON.stringify(row)).not.toContain('top-secret-value');
  expect((await listSsoServers()).find((s) => s.code === 'srv-acme')?.clientSecret).toBe('top-secret-value');
  expect(JSON.stringify(await listServers(system))).not.toMatch(/top-secret-value|"hub"/);
  const audit = (await pools.root.query(`select actor_type, object_id, diff from hdc_audit_log where action = 'server.added'`)).rows;
  expect(audit).toEqual([{ actor_type: 'system', object_id: 'srv-acme', diff: { isDefault: false, updated: false } }]);
  expect(JSON.stringify(audit)).not.toContain('top-secret-value');
});

test('повторное добавление того же кода обновляет сервер, код не меняется', async () => {
  await addServer(system, input);
  await addServer(system, { ...input, name: 'ACME LLC', clientSecret: 'rotated-secret' });
  expect((await listServers(system)).map((s) => [s.code, s.name])).toEqual([['srv-acme', 'ACME LLC']]);
  expect((await listSsoServers())[0]?.clientSecret).toBe('rotated-secret');
});

test('добавлять серверы может система и admin, но не care и не клиент', async () => {
  const f = await seedTwoOrgs();
  await expect(addServer(staffCtx(f.care), { ...input, code: 'x1' })).rejects.toMatchObject({ code: 'forbidden' });
  await expect(addServer(f.aAdmin.actor as never, { ...input, code: 'x2' })).rejects.toMatchObject({ code: 'forbidden' });
  await expect(
    addServer(staffCtx(f.adminStaff), { ...input, code: 'x3', baseUrl: 'https://x3.example', issuer: 'https://x3.example' }),
  ).resolves.toEqual({ code: 'x3' });
  expect((await pools.root.query(`select actor_id from hdc_audit_log where action = 'server.added'`)).rows).toEqual([
    { actor_id: f.adminStaff.userId },
  ]);
});

test('внутренний адрес, неверный код и неверные данные отклоняются, в реестр ничего не попадает', async () => {
  for (const bad of [
    { ...input, baseUrl: 'https://10.0.0.5' },
    { ...input, issuer: 'http://acme.smartup.example' },
    { ...input, code: 'Bad Code' },
    { ...input, clientSecret: '' },
    { ...input, roleMap: { director: 'admin' } },
    { ...input, endpoints: { authorization: 'https://169.254.169.254/a', token: 'https://x.example/t', userinfo: 'https://x.example/u', jwks: 'https://x.example/j' } },
    null,
  ])
    await expect(addServer(system, bad)).rejects.toMatchObject({ code: 'invalid_input' });
  expect((await pools.root.query('select 1 from hdu_servers')).rowCount).toBe(0);
});

test('сервер по умолчанию один', async () => {
  await addServer(system, { ...input, code: 'one', baseUrl: 'https://one.example', issuer: 'https://one.example', isDefault: true });
  await addServer(system, { ...input, code: 'two', baseUrl: 'https://two.example', issuer: 'https://two.example', isDefault: true });
  expect((await listServers(system)).filter((s) => s.isDefault).map((s) => s.code)).toEqual(['two']);
  expect(await findLoginServer({})).toEqual({ code: 'two', name: 'ACME', host: 'two.example' });
});

test('отключённый сервер не предлагается для входа и не передаётся библиотеке', async () => {
  await addServer(system, { ...input, code: 'gone', baseUrl: 'https://gone.example', issuer: 'https://gone.example', isDefault: true });
  await disableServer(system, 'gone');
  expect(await findLoginServer({ code: 'gone' })).toBeNull();
  // Отключён сервер по умолчанию: на другой сервер вход не переключается сам.
  expect(await findLoginServer({})).toBeNull();
  expect((await listSsoServers()).map((s) => s.code)).not.toContain('gone');
  expect((await pools.root.query(`select action from hdc_audit_log where object_id = 'gone' order by created_on`)).rows.map((r) => r.action)).toEqual([
    'server.added',
    'server.disabled',
  ]);
  await expect(disableServer(system, 'nope')).rejects.toMatchObject({ code: 'not_found' });
  await expect(disableServer(system, 'Bad Code')).rejects.toMatchObject({ code: 'invalid_input' });
});

test('сервер находится по адресу Smartup в любом написании', async () => {
  await addServer(system, input);
  for (const typed of ['acme.smartup.example', 'https://ACME.smartup.example/', ' https://acme.smartup.example/login?x=1 '])
    expect(await findServerByAddress(typed), typed).toEqual({ code: 'srv-acme' });
  for (const typed of ['unknown.smartup.example', 'javascript:alert(1)', '', 42, null, 'x'.repeat(3000)])
    expect(await findServerByAddress(typed), String(typed)).toBeNull();
});

test('локальные серверы входа разрешены, когда сам портал работает на localhost', async () => {
  expect(process.env.HUB_URL).toMatch(/^http:\/\/localhost/);
  await expect(
    addServer(system, { ...input, code: 'mock', baseUrl: 'http://localhost:3190', issuer: 'http://localhost:3190' }),
  ).resolves.toEqual({ code: 'mock' });
  expect(await findServerByAddress('localhost:3190')).toEqual({ code: 'mock' });
});

test('сервер с нерасшифровываемым секретом пропускается, остальные серверы и вход работают', async () => {
  await addServer(system, input);
  // Набор seedTwoOrgs кладёт в реестр сервер с поддельной зашифрованной строкой: так выглядит смена ключа.
  const f = await seedTwoOrgs();
  const lines: string[] = [];
  const spy = vi.spyOn(console, 'error').mockImplementation((line) => void lines.push(String(line)));
  const sso = await listSsoServers();
  spy.mockRestore();
  expect(sso.map((s) => s.code)).toEqual(['srv-acme']);
  expect(lines.join('\n')).toContain(f.server.code);
  expect(lines.join('\n')).not.toContain('v1.');
});

// --- Раздел "Настройки": реестр серверов в рабочем месте (задача 18, FR-ADM-01) ---

/** Ответ сервера Smartup на запрос документа discovery: объект JSON, текст или ошибка сети. */
async function withDiscovery<T>(body: unknown, run: () => Promise<T>): Promise<T> {
  const spy = spyOutbound().mockImplementation(async () => {
    if (body instanceof Error) throw body;
    if (typeof body === 'string') return new Response(body, { headers: { 'content-type': 'text/html' } });
    return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
  });
  try {
    return await run();
  } finally {
    spy.mockRestore();
  }
}

const good = {
  issuer: 'https://id.chk.example',
  authorization_endpoint: 'https://id.chk.example/a',
  token_endpoint: 'https://id.chk.example/t',
  userinfo_endpoint: 'https://id.chk.example/u',
  jwks_uri: 'https://id.chk.example/j',
  code_challenge_methods_supported: ['S256'],
};

test('проверка связи называет каждую проблему сервера', async () => {
  await addServer(system, { ...input, code: 'chk', issuer: 'https://id.chk.example', baseUrl: 'https://chk.example' });
  expect(await withDiscovery(good, () => checkServer(system, 'chk'))).toMatchObject({ ok: true, issues: [] });
  const bad = { ...good, issuer: 'https://other.example', code_challenge_methods_supported: ['plain'], userinfo_endpoint: undefined };
  // Адрес сведений о пользователе не обязателен: сведения портал берёт из подписанного id_token (проверка main, Q21).
  expect((await withDiscovery(bad, () => checkServer(system, 'chk'))).issues.sort()).toEqual(['issuer_mismatch', 'no_pkce_s256']);
  expect((await withDiscovery({ ...good, userinfo_endpoint: undefined }, () => checkServer(system, 'chk')))).toMatchObject({ ok: true, issues: [] });
  expect((await withDiscovery({ issuer: good.issuer }, () => checkServer(system, 'chk'))).issues.sort()).toEqual([
    'no_authorization_endpoint',
    'no_jwks',
    'no_pkce_s256',
    'no_token_endpoint',
  ]);
  expect((await withDiscovery(new Error('сеть'), () => checkServer(system, 'chk'))).issues).toEqual(['unreachable']);
  expect((await withDiscovery('<html>', () => checkServer(system, 'chk'))).issues).toEqual(['not_json']);
});

test('документ discovery ищется по адресу сервера входа, в том числе с путём', async () => {
  await addServer(system, { ...input, code: 'realm', issuer: 'https://id.chk.example/realms/smartup/', baseUrl: 'https://realm.example' });
  const urls: string[] = [];
  const spy = spyOutbound().mockImplementation(async (url) => {
    urls.push(String(url));
    return new Response(JSON.stringify({ ...good, issuer: 'https://id.chk.example/realms/smartup/' }));
  });
  expect((await checkServer(system, 'realm')).ok).toBe(true);
  spy.mockRestore();
  expect(urls).toEqual(['https://id.chk.example/realms/smartup/.well-known/openid-configuration']);
});

test('сервер с явными адресами проверяется по адресу ключей', async () => {
  const endpoints = { authorization: 'https://e.example/a', token: 'https://e.example/t', userinfo: 'https://e.example/u', jwks: 'https://e.example/j' };
  await addServer(system, { ...input, code: 'expl', issuer: 'https://e.example', baseUrl: 'https://expl.example', endpoints });
  const urls: string[] = [];
  const spy = spyOutbound().mockImplementation(async (url) => {
    urls.push(String(url));
    return new Response(JSON.stringify({ keys: [{ kty: 'RSA' }] }));
  });
  expect(await checkServer(system, 'expl')).toMatchObject({ ok: true, issues: [] });
  spy.mockRestore();
  expect(urls).toEqual(['https://e.example/j']);
  expect((await withDiscovery({ nothing: true }, () => checkServer(system, 'expl'))).issues).toEqual(['no_jwks']);
});

test('результат последней проверки виден в списке, проверка в журнал не пишется', async () => {
  await addServer(system, { ...input, code: 'chk', issuer: 'https://id.chk.example', baseUrl: 'https://chk.example' });
  expect((await listServers(system))[0]?.lastCheck).toBeNull();
  const result = await withDiscovery({ ...good, code_challenge_methods_supported: [] }, () => checkServer(system, 'chk'));
  expect((await listServers(system))[0]?.lastCheck).toEqual({ ok: false, issues: ['no_pkce_s256'], checkedOn: result.checkedOn });
  await withDiscovery(good, () => checkServer(system, 'chk'));
  expect((await listServers(system))[0]?.lastCheck).toMatchObject({ ok: true, issues: [] });
  expect((await pools.root.query(`select action from hdc_audit_log where object_id = 'chk'`)).rows.map((r) => r.action)).toEqual(['server.added']);
  await expect(checkServer(system, 'nope')).rejects.toMatchObject({ code: 'not_found' });
  await expect(checkServer(system, 'Bad Code')).rejects.toMatchObject({ code: 'invalid_input' });
  const f = await seedTwoOrgs();
  await expect(checkServer(f.care.actor, 'chk')).rejects.toMatchObject({ code: 'forbidden' });
});

test('изменение сервера без нового секрета сохраняет прежний, с новым заменяет', async () => {
  const f = await seedTwoOrgs();
  await addServer(system, { ...input, code: 'upd', issuer: 'https://id.upd.example', baseUrl: 'https://upd.example' });
  const ctx = staffCtx(f.adminStaff);
  await updateServer(ctx, { code: 'upd', name: 'Новое имя', clientSecret: '' });
  const upd = async () => (await listSsoServers()).find((s) => s.code === 'upd');
  expect((await upd())?.clientSecret).toBe('top-secret-value');
  expect((await listServers(system)).find((s) => s.code === 'upd')?.name).toBe('Новое имя');
  await updateServer(ctx, { code: 'upd', clientSecret: 'rotated-secret' });
  expect((await upd())?.clientSecret).toBe('rotated-secret');
  const audit = (await pools.root.query(`select actor_id, diff from hdc_audit_log where action = 'server.updated' order by created_on`)).rows;
  expect(audit).toEqual([
    { actor_id: f.adminStaff.userId, diff: { changed: ['name'] } },
    { actor_id: f.adminStaff.userId, diff: { changed: ['clientSecret'] } },
  ]);
  expect(JSON.stringify(audit)).not.toMatch(/rotated-secret|top-secret-value/);
});

test('изменение сервера проверяет адреса и меняет признак по умолчанию, адреса без discovery снимаются', async () => {
  const f = await seedTwoOrgs();
  const ctx = staffCtx(f.adminStaff);
  const endpoints = { authorization: 'https://e.example/a', token: 'https://e.example/t', userinfo: 'https://e.example/u', jwks: 'https://e.example/j' };
  await addServer(system, { ...input, code: 'upd', issuer: 'https://id.upd.example', baseUrl: 'https://upd.example', endpoints });
  await expect(updateServer(ctx, { code: 'upd', issuer: 'https://10.0.0.1' })).rejects.toMatchObject({ code: 'invalid_input' });
  await expect(updateServer(ctx, { code: 'upd', baseUrl: 'https://upd.example/path' })).rejects.toMatchObject({ code: 'invalid_input' });
  await expect(updateServer(ctx, { code: 'upd', roleMap: { director: 'admin' } })).rejects.toMatchObject({ code: 'invalid_input' });
  await expect(updateServer(ctx, { code: 'nope', name: 'x' })).rejects.toMatchObject({ code: 'not_found' });
  await updateServer(ctx, { code: 'upd', isDefault: true, endpoints: null, roleMap: { director: 'client_admin' } });
  const row = (await pools.root.query(`select is_default, oidc_endpoints, role_map from hdu_servers where code = 'upd'`)).rows[0];
  expect(row).toEqual({ is_default: true, oidc_endpoints: null, role_map: { director: 'client_admin' } });
});

test('реестр меняет только admin и только со свежим входом', async () => {
  const f = await seedTwoOrgs();
  await expect(updateServer(staffCtx(f.care), { code: f.server.code, name: 'x' })).rejects.toMatchObject({ code: 'forbidden' });
  const ctx = staffCtx(f.adminStaff);
  const stale = new Date(+ctx.freshAuthAt! + 901e3);
  await expect(updateServer(ctx, { code: f.server.code, name: 'x' }, stale)).rejects.toMatchObject({ code: 'stale_session' });
  await expect(enableServer(ctx, f.server.code, stale)).rejects.toMatchObject({ code: 'stale_session' });
  await expect(disableServer({ ...ctx, freshAuthAt: new Date(Date.now() - 901e3) }, f.server.code)).rejects.toMatchObject({
    code: 'stale_session',
  });
  await expect(
    addServer({ ...ctx, freshAuthAt: new Date(Date.now() - 901e3) }, { ...input, code: 'late', baseUrl: 'https://late.example', issuer: 'https://late.example' }),
  ).rejects.toMatchObject({ code: 'stale_session' });
  await expect(enableServer(ctx, 'нет-такого')).rejects.toMatchObject({ code: 'invalid_input' });
  await expect(enableServer(ctx, 'nope')).rejects.toMatchObject({ code: 'not_found' });
});

test('отключённый сервер включается снова, оба действия в журнале', async () => {
  const f = await seedTwoOrgs();
  const ctx = staffCtx(f.adminStaff);
  await addServer(system, { ...input, code: 'cycle', baseUrl: 'https://cycle.example', issuer: 'https://cycle.example' });
  await disableServer(ctx, 'cycle');
  expect((await findLoginServer({ code: 'cycle' }))).toBeNull();
  await enableServer(ctx, 'cycle');
  expect((await findLoginServer({ code: 'cycle' }))?.code).toBe('cycle');
  expect(
    (await pools.root.query(`select action, actor_id from hdc_audit_log where object_id = 'cycle' order by created_on`)).rows,
  ).toEqual([
    { action: 'server.added', actor_id: null },
    { action: 'server.disabled', actor_id: f.adminStaff.userId },
    { action: 'server.enabled', actor_id: f.adminStaff.userId },
  ]);
});

test('адрес возврата строится от адреса портала', () => {
  expect(serverCallbackUrl('mock')).toBe(`${process.env.HUB_URL}/api/auth/sso/callback/mock`);
});

test('адрес Smartup или сервера входа, который уже есть у другого сервера, не принимается', async () => {
  const f = await seedTwoOrgs();
  await addServer(system, input);
  await expect(addServer(system, { ...input, code: 'twin', issuer: 'https://twin.example' })).rejects.toMatchObject({ code: 'server_taken' });
  await expect(addServer(system, { ...input, code: 'twin', baseUrl: 'https://twin.example' })).rejects.toMatchObject({ code: 'server_taken' });
  await addServer(system, { ...input, code: 'twin', baseUrl: 'https://twin.example', issuer: 'https://twin.example' });
  await expect(updateServer(staffCtx(f.adminStaff), { code: 'twin', issuer: input.issuer })).rejects.toMatchObject({ code: 'server_taken' });
});

test('форма "Добавить сервер" не перезаписывает сервер с тем же кодом, команда консоли обновляет (итоговая проверка, I6)', async () => {
  const f = await seedTwoOrgs();
  await addServer(system, input);
  await expect(
    addServer(staffCtx(f.adminStaff), { ...input, name: 'Чужой', baseUrl: 'https://other.example', issuer: 'https://other.example', clientSecret: 'other' }),
  ).rejects.toMatchObject({ code: 'server_taken' });
  expect((await listSsoServers()).find((s) => s.code === input.code)).toMatchObject({ issuer: input.issuer, clientSecret: 'top-secret-value' });
  await addServer(system, { ...input, name: 'ACME 2' });
  expect((await listServers(system)).find((s) => s.code === input.code)?.name).toBe('ACME 2');
});
