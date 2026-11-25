import { afterAll, afterEach, beforeAll, expect, test } from 'vitest';
import type { SystemActor } from '@/db/with-actor';
import { addServer, disableServer, embedOriginsByKey, updateWidgetSettings } from '@/modules/hdu/api/servers';
import { setDnsResolverForTests } from '@/modules/hdu/url-safety';
import { embedAncestors, registerEmbedOriginsLoader } from '@/security/embed-frame';
import { staffCtx } from './helpers/auth';
import { pools } from './helpers/db';
import { seedTwoOrgs } from './isolation/fixture';

// Адреса встраивания для прокси (план M6, задача 3, решение 6): по ключу встраивания только адреса своего сервера,
// отключённый сервер не встраивается; правка реестра в процессе обновляет список сразу, без ожидания 60 секунд.

const system: SystemActor = { type: 'system', job: 'test' };

beforeAll(() => setDnsResolverForTests(async () => ['203.0.113.10']));
afterAll(() => setDnsResolverForTests(null));
afterEach(() => registerEmbedOriginsLoader(embedOriginsByKey));

async function keyOf(code: string): Promise<string> {
  return (await pools.root.query(`select embed_key from hdu_servers where code = $1`, [code])).rows[0].embed_key as string;
}

test('по ключу встраивания адрес Smartup Web и дополнительные адреса своего сервера; отключённого сервера нет', async () => {
  const f = await seedTwoOrgs();
  for (const code of ['cloud', 'dedicated'])
    await addServer(system, { code, name: code, baseUrl: `https://${code}.smartup.example`, issuer: `https://id.${code}.smartup.example`, clientId: 'hub', clientSecret: 's' });
  await updateWidgetSettings(staffCtx(f.adminStaff), { code: 'cloud', mode: null, embedOrigins: ['https://web2.cloud.example'] });
  const map = await embedOriginsByKey();
  expect(map.get(await keyOf('cloud'))).toEqual(['https://cloud.smartup.example', 'https://web2.cloud.example']);
  expect(map.get(await keyOf('dedicated'))).toEqual(['https://dedicated.smartup.example']);
  await disableServer(system, 'dedicated');
  expect((await embedOriginsByKey()).has(await keyOf('dedicated'))).toBe(false);
});

test('правка реестра в этом процессе сразу меняет список прокси', async () => {
  const f = await seedTwoOrgs();
  registerEmbedOriginsLoader(embedOriginsByKey);
  await addServer(system, { code: 'cloud', name: 'cloud', baseUrl: 'https://cloud.smartup.example', issuer: 'https://id.cloud.smartup.example', clientId: 'hub', clientSecret: 's' });
  const key = await keyOf('cloud');
  expect(await embedAncestors(key)).toEqual(['https://cloud.smartup.example']);
  await updateWidgetSettings(staffCtx(f.adminStaff), { code: 'cloud', mode: null, embedOrigins: ['https://web2.cloud.example'] });
  // Обновление идёт в фоне сразу после правки: ждём его, а не 60 секунд.
  await expect.poll(() => embedAncestors(key)).toEqual(['https://cloud.smartup.example', 'https://web2.cloud.example']);
  await disableServer(staffCtx(f.adminStaff), 'cloud');
  await expect.poll(() => embedAncestors(key)).toEqual([]);
});
