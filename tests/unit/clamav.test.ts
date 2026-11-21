import { afterAll, beforeAll, expect, test } from 'vitest';
import { createClamavScanner } from '@/modules/hdc/antivirus/clamav';
import { createStubScanner } from '@/modules/hdc/antivirus/stub';
import { EICAR, type FakeClamd, startFakeClamd } from '../helpers/fake-clamd';

// Протокол ClamAV (раздел 11.11, решение 0027): zINSTREAM, куски до 64 КБ, тайм-аут, ошибки протокола.

let clamd: FakeClamd;
beforeAll(async () => {
  clamd = await startFakeClamd();
});
afterAll(() => clamd.close());

const streamOf = (...parts: Uint8Array[]) =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      for (const part of parts) controller.enqueue(part);
      controller.close();
    },
  });
const text = (value: string) => new TextEncoder().encode(value);
const scanner = (timeoutMs = 30_000) => createClamavScanner({ host: '127.0.0.1', port: clamd.port, timeoutMs });

test('чистый поток: clean, куски не больше 64 КБ, принято всё', async () => {
  clamd.setMode('ok');
  clamd.chunkSizes.length = 0;
  // Куски источника больше предела протокола: сканер режет их сам.
  const big = new Uint8Array(200 * 1024).fill(65);
  expect(await scanner().scan(streamOf(big, text('хвост')))).toEqual({ clean: true });
  expect(clamd.received()).toBe(200 * 1024 + text('хвост').length);
  expect(Math.max(...clamd.chunkSizes)).toBeLessThanOrEqual(64 * 1024);
});

test('найденная подпись: clean false и имя подписи', async () => {
  clamd.setMode('ok');
  expect(await scanner().scan(streamOf(text('начало '), text(EICAR)))).toEqual({ clean: false, signature: 'Eicar-Test-Signature' });
});

test('оборванное соединение и молчание дольше тайм-аута бросают ошибку', async () => {
  clamd.setMode('drop');
  await expect(scanner().scan(streamOf(text('x')))).rejects.toThrow(/ClamAV/);
  clamd.setMode('silent');
  await expect(scanner(200).scan(streamOf(text('x')))).rejects.toThrow(/ClamAV/);
  clamd.setMode('ok');
});

test('недоступный ClamAV бросает ошибку', async () => {
  await expect(createClamavScanner({ host: '127.0.0.1', port: 1, timeoutMs: 1000 }).scan(streamOf(text('x')))).rejects.toThrow(/ClamAV/);
});

test('заглушка находит EICAR и пропускает остальное', async () => {
  expect(await createStubScanner().scan(streamOf(text('обычный текст')))).toEqual({ clean: true });
  const half = Math.floor(EICAR.length / 2);
  expect(await createStubScanner().scan(streamOf(text(EICAR.slice(0, half)), text(EICAR.slice(half))))).toEqual({
    clean: false,
    signature: 'Eicar-Test-Signature',
  });
});
