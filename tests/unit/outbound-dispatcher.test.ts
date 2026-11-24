import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { BlockedAddressError, setDnsResolverForTests } from '@/security/outbound';
import { guardedHostsForTests, installOutboundGuard, setGuardedOrigins } from '@/security/outbound-dispatcher';

// Запросы библиотеки входа к серверам Smartup (вопрос 18, решение владельца 24.11.2026; остаток находки S14).
// Библиотека ходит общим fetch и своего сетевого слоя не принимает. Поэтому проверка адреса при соединении стоит
// в общем диспетчере запросов и действует на узлы серверов Smartup: имя, которое в момент соединения разрешилось
// во внутренний адрес, отклоняется, даже если при записи сервера в реестр оно было внешним.

let server: http.Server;
let port: number;
beforeAll(async () => {
  server = http.createServer((_, res) => res.end('внутренний ответ'));
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  port = (server.address() as AddressInfo).port;
  installOutboundGuard({ allowLoopback: false });
});
afterAll(async () => {
  setDnsResolverForTests(null);
  setGuardedOrigins([]);
  await new Promise((done) => server.close(done));
});

test('узел сервера Smartup, который при соединении разрешился во внутренний адрес, отклоняется', async () => {
  setGuardedOrigins([`http://smartup.rebind.example:${port}`]);
  // При записи в реестр имя было внешним, теперь DNS отдаёт адрес внутренней сети.
  setDnsResolverForTests(async () => ['127.0.0.1']);
  // Отказ даёт именно проверка адреса, а не сбой разрешения имени: причина ошибки названа.
  const blocked = async (path: string) => {
    const error = await fetch(`http://smartup.rebind.example:${port}${path}`).then(
      () => null,
      (reason: unknown) => reason,
    );
    const chain = [error, (error as { cause?: unknown } | null)?.cause, ((error as { cause?: { cause?: unknown } } | null)?.cause as { cause?: unknown } | undefined)?.cause];
    return chain.some((item) => item instanceof BlockedAddressError);
  };
  expect(await blocked('/token')).toBe(true);
  setDnsResolverForTests(async () => ['10.0.0.5']);
  expect(await blocked('/jwks')).toBe(true);
});

test('внутренний адрес цифрами у узла из списка тоже отклоняется', async () => {
  setGuardedOrigins([`http://127.0.0.1:${port}`]);
  await expect(fetch(`http://127.0.0.1:${port}/userinfo`)).rejects.toThrow();
});

test('запросы к остальным узлам идут как раньше: хранилище, почта и Telegram проверкой не затронуты', async () => {
  setGuardedOrigins(['https://smartup.other.example']);
  const response = await fetch(`http://127.0.0.1:${port}/`);
  expect(await response.text()).toBe('внутренний ответ');
});

test('портал на localhost (разработка и тесты): ложный сервер входа на localhost допускается', async () => {
  installOutboundGuard({ allowLoopback: true });
  setGuardedOrigins([`http://127.0.0.1:${port}`]);
  expect(await (await fetch(`http://127.0.0.1:${port}/`)).text()).toBe('внутренний ответ');
  installOutboundGuard({ allowLoopback: false });
  expect(guardedHostsForTests()).toEqual(['127.0.0.1']);
});
