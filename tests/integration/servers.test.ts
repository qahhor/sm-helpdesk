import { afterAll, beforeAll, expect, test, vi } from 'vitest';
import type { SystemActor } from '@/db/with-actor';
import { addServer, disableServer, findLoginServer, findServerByAddress, listServers } from '@/modules/hdu/api/servers';
import { listSsoServers } from '@/modules/hdu/core/servers';
import { setDnsResolverForTests } from '@/modules/hdu/url-safety';
import { pools } from './helpers/db';
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
  await expect(addServer(f.care.actor, { ...input, code: 'x1' })).rejects.toMatchObject({ code: 'forbidden' });
  await expect(addServer(f.aAdmin.actor as never, { ...input, code: 'x2' })).rejects.toMatchObject({ code: 'forbidden' });
  await expect(
    addServer(f.adminStaff.actor, { ...input, code: 'x3', baseUrl: 'https://x3.example', issuer: 'https://x3.example' }),
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
