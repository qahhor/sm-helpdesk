import { readdirSync, readFileSync } from 'node:fs';
import { expect, test } from 'vitest';
import { LOGO_ASSETS, pickTezAsset, TEZ_ASSETS, tezClearSpace } from '@/ui/brand/tez-assets';
import { showcaseEnabled } from '@/ui/showcase';

test('выбор файла Теза по размеру и фону (раздел 8.13 ТЗ)', () => {
  // меньше 16 px Тез не ставится
  expect(pickTezAsset(15, false)).toBeNull();
  expect(pickTezAsset(16, false)).toBe('icon');
  expect(pickTezAsset(40, false)).toBe('icon');
  expect(pickTezAsset(41, false)).toBe('main');
  expect(pickTezAsset(40, true)).toBe('iconOnDark');
  expect(pickTezAsset(120, true)).toBe('mainOnDark');
});

test('охранное поле 1/6 размера', () => {
  expect(tezClearSpace(24)).toBe(4);
  expect(tezClearSpace(40)).toBe(7);
  expect(tezClearSpace(120)).toBe(20);
});

test('файлы для веба совпадают с файлами пакета бренда', () => {
  for (const name of Object.values(TEZ_ASSETS))
    expect(readFileSync(`public/brand/tez/${name}`)).toEqual(readFileSync(`docs/brand/tez/${name}`));
  expect(new Set(Object.values(TEZ_ASSETS)).size).toBe(4);
  for (const { file } of Object.values(LOGO_ASSETS))
    expect(readFileSync(`public/brand/logo/${file}`)).toEqual(readFileSync(`docs/brand/logo/${file}`));
});

test('в public лежат только используемые файлы бренда', () => {
  expect(readdirSync('public/brand/tez').sort()).toEqual(Object.values(TEZ_ASSETS).sort());
  expect(readdirSync('public/brand/logo').sort()).toEqual(
    Object.values(LOGO_ASSETS)
      .map((asset) => asset.file)
      .sort(),
  );
});

test('витрина включается только флагом', () => {
  expect(showcaseEnabled({ HUB_SHOWCASE: '0' })).toBe(false);
  expect(showcaseEnabled({ HUB_SHOWCASE: '1' })).toBe(true);
});
