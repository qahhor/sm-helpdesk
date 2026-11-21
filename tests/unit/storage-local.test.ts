import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { createLocalHandler, createLocalStorage, verifyLocalUrl } from '@/modules/hdc/storage/local';

// Локальная заглушка хранилища (решение 0027): файлы в каталоге, ссылки подписаны HMAC и ведут на обработчик портала.

const setup = () => {
  const dir = mkdtempSync(join(tmpdir(), 'hub-storage-'));
  let now = new Date('2026-11-21T10:00:00Z');
  const storage = createLocalStorage({ dir, baseUrl: 'http://localhost:3000', secret: 'k'.repeat(32), now: () => now });
  return { dir, storage, tick: (ms: number) => (now = new Date(now.getTime() + ms)), now: () => now };
};

test('подписанная ссылка на загрузку проверяется и записывает файл', async () => {
  const { dir, storage, now } = setup();
  const { url, headers } = await storage.presignUpload('quarantine/0192-a', 'text/plain', 5);
  expect(headers).toEqual({ 'Content-Type': 'text/plain' });
  const params = new URL(url).searchParams;
  expect(verifyLocalUrl(params, 'k'.repeat(32), now())).toEqual({ op: 'put', key: 'quarantine/0192-a', mime: 'text/plain', size: 5 });
  await storage.write('quarantine/0192-a', new TextEncoder().encode('hello'));
  expect(readFileSync(join(dir, 'quarantine/0192-a'), 'utf8')).toBe('hello');
  expect(await storage.head('quarantine/0192-a')).toEqual({ size: 5 });
  await storage.move('quarantine/0192-a', 'files/org/0192-a');
  expect(await storage.head('quarantine/0192-a')).toBeNull();
  expect(await new Response(await storage.stream('files/org/0192-a')).text()).toBe('hello');
  await storage.remove('files/org/0192-a');
  expect(await storage.head('files/org/0192-a')).toBeNull();
});

test('просроченная, подменённая и ведущая за пределы каталога ссылка отклоняется', async () => {
  const { storage, tick, now } = setup();
  const params = new URL((await storage.presignUpload('quarantine/0192-b', 'image/png', 10)).url).searchParams;
  const changed = new URLSearchParams(params);
  changed.set('size', '999999');
  expect(verifyLocalUrl(changed, 'k'.repeat(32), now())).toBeNull();
  const traversal = new URLSearchParams(params);
  traversal.set('key', '../../etc/passwd');
  expect(verifyLocalUrl(traversal, 'k'.repeat(32), now())).toBeNull();
  expect(verifyLocalUrl(params, 'другой ключ подписи длиной 32 зн', now())).toBeNull();
  tick(301_000);
  expect(verifyLocalUrl(params, 'k'.repeat(32), now())).toBeNull();
  await expect(storage.presignUpload('../x', 'image/png', 1)).rejects.toThrow();
});

test('ссылка на скачивание несёт способ показа и имя файла', async () => {
  const { storage, now } = setup();
  const params = new URL(await storage.presignDownload('files/o/0192-c', 'отчёт.pdf', 60)).searchParams;
  expect(verifyLocalUrl(params, 'k'.repeat(32), now())).toEqual({ op: 'get', key: 'files/o/0192-c', disposition: 'attachment', name: 'отчёт.pdf' });
});

test('обработчик локального хранилища: принимает файл по ссылке, отдаёт его с Content-Disposition, выключен - 404', async () => {
  const { storage, now } = setup();
  const handle = createLocalHandler({ storage, secret: 'k'.repeat(32), enabled: true, now });
  const { url } = await storage.presignUpload('quarantine/0192-d', 'image/png', 4);
  const put = (init: RequestInit & { url?: string }) => handle(new Request(init.url ?? url, { method: 'PUT', ...init }));
  // Другой тип, другой размер и чужая ссылка не принимаются.
  expect((await put({ headers: { 'Content-Type': 'text/html' }, body: new Uint8Array(4) })).status).toBe(400);
  expect((await put({ headers: { 'Content-Type': 'image/png' }, body: new Uint8Array(5) })).status).toBe(400);
  expect((await put({ headers: { 'Content-Type': 'image/png' }, body: new Uint8Array(3) })).status).toBe(400);
  expect((await put({ url: url.replace(/sig=[0-9a-f]+/, `sig=${'0'.repeat(64)}`), headers: { 'Content-Type': 'image/png' }, body: new Uint8Array(4) })).status).toBe(403);
  expect(await storage.head('quarantine/0192-d')).toBeNull();
  expect((await put({ headers: { 'Content-Type': 'image/png' }, body: new Uint8Array([1, 2, 3, 4]) })).status).toBe(200);
  expect(await storage.head('quarantine/0192-d')).toEqual({ size: 4 });
  // Ссылка на загрузку не годится для скачивания.
  expect((await handle(new Request(url))).status).toBe(403);
  const got = await handle(new Request(await storage.presignDownload('quarantine/0192-d', 'снимок.png', 60, true)));
  expect(got.status).toBe(200);
  expect(got.headers.get('content-type')).toBe('image/png');
  expect(got.headers.get('content-disposition')).toMatch(/^inline; filename="______.png"; filename\*=UTF-8''/);
  expect(got.headers.get('x-content-type-options')).toBe('nosniff');
  expect(got.headers.get('cache-control')).toBe('no-store');
  expect(new Uint8Array(await got.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3, 4]));
  const file = await handle(new Request(await storage.presignDownload('quarantine/0192-d', 'page.html', 60)));
  expect(file.headers.get('content-type')).toBe('application/octet-stream');
  expect(file.headers.get('content-disposition')).toMatch(/^attachment; /);
  expect((await handle(new Request(await storage.presignDownload('quarantine/none', 'x.png', 60)))).status).toBe(404);
  const off = createLocalHandler({ storage, secret: 'k'.repeat(32), enabled: false, now });
  expect((await off(new Request(url, { method: 'PUT', headers: { 'Content-Type': 'image/png' }, body: new Uint8Array(4) }))).status).toBe(404);
});
