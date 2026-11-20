import { expect, test } from 'vitest';
import { assertPublicUrl } from '@/modules/hdu/url-safety';

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
