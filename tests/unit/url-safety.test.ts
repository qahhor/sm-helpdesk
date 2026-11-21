import { expect, test, vi } from 'vitest';
import { assertPublicUrl, isPrivateAddress, safeFetchJson } from '@/modules/hdu/url-safety';

const publicDns = async () => ['203.0.113.10'];

test('адрес сервера Smartup: только https и только внешний узел', async () => {
  await expect(assertPublicUrl('https://acme.smartup.example', { allowLoopback: false, resolve: publicDns })).resolves.toBeInstanceOf(URL);
  await expect(assertPublicUrl('https://id.smartup.example/realm', { allowLoopback: false, resolve: publicDns })).resolves.toHaveProperty(
    'pathname',
    '/realm',
  );
  for (const bad of [
    'http://acme.smartup.example',
    'ftp://acme.smartup.example',
    'https://localhost',
    'https://app.localhost',
    'https://127.0.0.1',
    'https://2130706433',
    'https://10.0.0.5',
    'https://100.64.0.1',
    'https://172.16.1.1',
    'https://192.168.1.1',
    'https://169.254.169.254',
    'https://224.0.0.1',
    'https://[::1]',
    'https://[::]',
    'https://[fd00::1]',
    'https://[fe80::1]',
    'https://[::ffff:10.0.0.1]',
    'https://[::ffff:203.0.113.10]',
    'https://0.0.0.0',
    'https://db.internal',
    'https://db.internal.',
    'https://printer.local',
    'https://user:pass@acme.smartup.example',
    'not a url',
    '',
  ])
    await expect(assertPublicUrl(bad, { allowLoopback: false, resolve: publicDns }), bad).rejects.toMatchObject({ code: 'invalid_input' });
});

test('имя, которое разрешается во внутренний адрес или не разрешается совсем, отклоняется', async () => {
  for (const resolve of [
    async () => ['203.0.113.10', '10.0.0.7'],
    async () => ['::1'],
    async () => [],
    async () => {
      throw new Error('ENOTFOUND');
    },
  ])
    await expect(assertPublicUrl('https://rebind.example', { allowLoopback: false, resolve })).rejects.toMatchObject({ code: 'invalid_input' });
});

test('localhost допускается только в локальном режиме', async () => {
  for (const local of ['http://localhost:3190', 'http://127.0.0.1:3191', 'https://localhost'])
    await expect(assertPublicUrl(local, { allowLoopback: true }), local).resolves.toBeInstanceOf(URL);
  await expect(assertPublicUrl('http://localhost:3190', { allowLoopback: false })).rejects.toMatchObject({ code: 'invalid_input' });
  // Локальный режим не открывает остальные внутренние адреса.
  await expect(assertPublicUrl('http://10.0.0.5', { allowLoopback: true })).rejects.toMatchObject({ code: 'invalid_input' });
  await expect(assertPublicUrl('http://acme.smartup.example', { allowLoopback: true, resolve: publicDns })).rejects.toMatchObject({
    code: 'invalid_input',
  });
});

// Загрузка документа с сервера Smartup (проверка связи, FR-ADM-01): адрес проверяется в момент запроса.
const json = (body: unknown, init: ResponseInit = {}) => vi.fn<typeof globalThis.fetch>(async () => new Response(JSON.stringify(body), init));
const opts = { timeoutMs: 50, maxBytes: 1000, allowLoopback: false, resolve: async () => ['203.0.113.10'] };
const target = () => new URL('https://id.smartup.example/x');

test('документ загружается только с внешнего адреса, без перенаправлений и в пределах размера', async () => {
  await expect(safeFetchJson(target(), { ...opts, fetch: json({ a: 1 }) })).resolves.toEqual({ a: 1 });
  await expect(safeFetchJson(target(), { ...opts, resolve: async () => ['10.0.0.1'], fetch: json({}) })).rejects.toMatchObject({
    code: 'invalid_input',
  });
  await expect(
    safeFetchJson(target(), { ...opts, fetch: json({}, { status: 302, headers: { location: 'http://169.254.169.254/' } }) }),
  ).rejects.toMatchObject({ reason: 'unreachable' });
  await expect(safeFetchJson(target(), { ...opts, fetch: json({ big: 'x'.repeat(5000) }) })).rejects.toMatchObject({ reason: 'too_large' });
  await expect(safeFetchJson(target(), { ...opts, fetch: vi.fn(() => new Promise<Response>(() => {})) })).rejects.toMatchObject({
    reason: 'timeout',
  });
  const fetch = json({});
  await safeFetchJson(target(), { ...opts, fetch });
  expect(fetch.mock.calls[0]?.[1]).toMatchObject({ redirect: 'error' });
});

test('ответ не JSON, ошибка сети и ответ с ошибкой называются по-разному', async () => {
  const html = vi.fn(async () => new Response('<html>', { headers: { 'content-type': 'text/html' } }));
  await expect(safeFetchJson(target(), { ...opts, fetch: html })).rejects.toMatchObject({ reason: 'not_json' });
  await expect(safeFetchJson(target(), { ...opts, fetch: vi.fn(async () => Promise.reject(new TypeError('сеть'))) })).rejects.toMatchObject({
    reason: 'unreachable',
  });
  await expect(safeFetchJson(target(), { ...opts, fetch: json({}, { status: 500 }) })).rejects.toMatchObject({ reason: 'unreachable' });
  // Заявленный размер больше предела: тело не читается.
  const big = vi.fn(async () => new Response('{}', { headers: { 'content-length': '999999' } }));
  await expect(safeFetchJson(target(), { ...opts, fetch: big })).rejects.toMatchObject({ reason: 'too_large' });
});

test('адреса IPv6 со встроенным IPv4 закрыты: 6to4, Teredo, локальный NAT64 (итоговая проверка M1, мелкое 8)', () => {
  for (const address of ['2002:7f00:1::1', '2002:a00:1::', '2001:0:4136:e378:8000:63bf:3fff:fdd2', '64:ff9b:1::a00:1'])
    expect(isPrivateAddress(address), address).toBe(true);
  // Документационный диапазон 2001:db8::/32 рядом, но не внутри 2001::/32.
  expect(isPrivateAddress('2001:db8::1')).toBe(false);
  expect(isPrivateAddress('2a00:1450:4001::1')).toBe(false);
});
