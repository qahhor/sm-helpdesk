import { afterEach, expect, test, vi } from 'vitest';
import { embedAncestors, isEmbedPath, isWidgetPath, refreshEmbedOrigins, registerEmbedOriginsLoader } from '@/security/embed-frame';

// Адреса встраивания страниц виджета по ключу сервера (план M6, задача 3, решение 6).

const A = 'a'.repeat(32);
const B = 'b'.repeat(32);

afterEach(() => {
  registerEmbedOriginsLoader(null);
  vi.useRealTimers();
});

test('по ключу только адреса своего сервера; неизвестный, неверный и пустой ключ: никому', async () => {
  registerEmbedOriginsLoader(async () => new Map([[A, ['https://a.smartup.example', 'https://web2.a.example']], [B, ['https://b.smartup.example']]]));
  expect(await embedAncestors(A)).toEqual(['https://a.smartup.example', 'https://web2.a.example']);
  expect(await embedAncestors(B)).toEqual(['https://b.smartup.example']);
  for (const key of ['c'.repeat(32), 'A'.repeat(32), `${A} `, "a' https://evil.example", '', null]) expect(await embedAncestors(key), String(key)).toEqual([]);
});

test('без загрузчика встраивать нельзя никому', async () => {
  expect(await embedAncestors(A)).toEqual([]);
});

test('список держится 60 секунд, потом загружается заново; правка реестра обновляет сразу', async () => {
  vi.useFakeTimers({ toFake: ['Date'], now: 1_000_000 });
  let origins = ['https://a.smartup.example'];
  const loader = vi.fn(async () => new Map([[A, origins]]));
  registerEmbedOriginsLoader(loader);
  expect(await embedAncestors(A)).toEqual(['https://a.smartup.example']);
  origins = ['https://new.a.example'];
  vi.setSystemTime(1_000_000 + 59_000);
  expect(await embedAncestors(A)).toEqual(['https://a.smartup.example']);
  expect(loader).toHaveBeenCalledTimes(1);
  vi.setSystemTime(1_000_000 + 60_000);
  expect(await embedAncestors(A)).toEqual(['https://new.a.example']);
  expect(loader).toHaveBeenCalledTimes(2);
  origins = ['https://third.a.example'];
  await refreshEmbedOrigins();
  expect(await embedAncestors(A)).toEqual(['https://third.a.example']);
});

test('одновременные запросы ждут одну загрузку; сбой базы оставляет прежний список и повторяется через 5 секунд', async () => {
  vi.useFakeTimers({ toFake: ['Date'], now: 2_000_000 });
  let fail = false;
  const loader = vi.fn(async () => {
    if (fail) throw new Error('база недоступна');
    return new Map([[A, ['https://a.smartup.example']]]);
  });
  registerEmbedOriginsLoader(loader);
  await Promise.all([embedAncestors(A), embedAncestors(A), embedAncestors(B)]);
  expect(loader).toHaveBeenCalledTimes(1);
  fail = true;
  vi.setSystemTime(2_000_000 + 61_000);
  expect(await embedAncestors(A)).toEqual(['https://a.smartup.example']);
  expect(loader).toHaveBeenCalledTimes(2);
  vi.setSystemTime(2_000_000 + 63_000);
  await embedAncestors(A);
  expect(loader).toHaveBeenCalledTimes(2);
  vi.setSystemTime(2_000_000 + 67_000);
  await embedAncestors(A);
  expect(loader).toHaveBeenCalledTimes(3);
});

test('страницы виджета и мобильного приложения по адресу', () => {
  for (const path of ['/ru/embed', '/ru/embed/report', '/uz/embed/tickets/SUP-1']) expect(isEmbedPath(path), path).toBe(true);
  for (const path of ['/ru', '/ru/embedded', '/ru/tickets/embed', '/embed/report', '/ru/m/report', '/api/embed/session']) expect(isEmbedPath(path), path).toBe(false);
  for (const path of ['/ru/embed/report', '/en/m/report', '/ru/m']) expect(isWidgetPath(path), path).toBe(true);
  for (const path of ['/ru/me', '/ru/tickets', '/ru/mobile']) expect(isWidgetPath(path), path).toBe(false);
});
