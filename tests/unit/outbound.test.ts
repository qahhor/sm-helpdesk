import { createServer as createHttpServer, type Server } from 'node:http';
import { connect, createServer as createTcpServer } from 'node:net';
import type { AddressInfo } from 'node:net';
import { afterEach, expect, test } from 'vitest';
import { safeFetchJson } from '@/modules/hdu/url-safety';
import { BlockedAddressError, createGuardedFetch, guardedLookup, isPrivateAddress } from '@/security/outbound';

// Общий сетевой слой исходящих запросов (аудит 23.11.2026, находки S14 и S15): имя узла разрешается и проверяется
// в момент соединения, а не только до запроса. Подмена ответа DNS между проверкой и соединением не уводит
// запрос во внутреннюю сеть. Переадресации слой не выполняет.

const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of closers.splice(0)) await close();
});

async function httpServer(handler: Parameters<typeof createHttpServer>[1]): Promise<{ port: number; hits: () => number }> {
  let hits = 0;
  const server: Server = createHttpServer((req, res) => {
    hits += 1;
    handler?.(req, res);
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  closers.push(() => new Promise((done) => server.close(() => done())));
  return { port: (server.address() as AddressInfo).port, hits: () => hits };
}

/** Порт, который считает соединения: запроса TLS к нему быть не должно. */
async function tcpCounter(): Promise<{ port: number; connections: () => number }> {
  let connections = 0;
  const server = createTcpServer((socket) => {
    connections += 1;
    socket.destroy();
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  closers.push(() => new Promise((done) => server.close(() => done())));
  return { port: (server.address() as AddressInfo).port, connections: () => connections };
}

test('запрос идёт на локальный сервер только в локальном режиме', async () => {
  const srv = await httpServer((_req, res) => res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}'));
  const local = createGuardedFetch({ allowLoopback: true });
  const response = await local(`http://127.0.0.1:${srv.port}/doc`);
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ ok: true });
  await expect(createGuardedFetch({ allowLoopback: false })(`http://127.0.0.1:${srv.port}/doc`)).rejects.toBeInstanceOf(BlockedAddressError);
  await expect(createGuardedFetch({ allowLoopback: false })(`https://127.0.0.1:${srv.port}/doc`)).rejects.toBeInstanceOf(BlockedAddressError);
  expect(srv.hits()).toBe(1);
});

test('имя, которое в момент соединения ведёт во внутреннюю сеть, отклоняется до соединения', async () => {
  const inner = await tcpCounter();
  for (const answer of [['127.0.0.1'], ['203.0.113.10', '10.0.0.5'], ['::1'], ['169.254.169.254'], []]) {
    const guarded = createGuardedFetch({ allowLoopback: false, resolve: async () => answer });
    await expect(guarded(`https://rebind.smartup.example:${inner.port}/x`), JSON.stringify(answer)).rejects.toBeInstanceOf(BlockedAddressError);
  }
  expect(inner.connections()).toBe(0);
});

test('подмена ответа DNS между проверкой адреса и соединением не открывает внутренний адрес (S14)', async () => {
  const inner = await tcpCounter();
  let calls = 0;
  // Первая проверка видит внешний адрес, соединение получает внутренний.
  const resolve = async () => (calls++ === 0 ? ['203.0.113.10'] : ['127.0.0.1']);
  await expect(
    safeFetchJson(new URL(`https://rebind.smartup.example:${inner.port}/.well-known/openid-configuration`), { timeoutMs: 2000, maxBytes: 1000, allowLoopback: false, resolve }),
  ).rejects.toMatchObject({ code: 'invalid_input' });
  expect(calls).toBe(2);
  expect(inner.connections()).toBe(0);
});

test('переадресацию слой не выполняет: ответ 302 возвращается как есть', async () => {
  const target = await httpServer((_req, res) => res.writeHead(200).end('secret'));
  const srv = await httpServer((_req, res) => res.writeHead(302, { location: `http://127.0.0.1:${target.port}/` }).end());
  const response = await createGuardedFetch({ allowLoopback: true })(`http://127.0.0.1:${srv.port}/`);
  expect(response.status).toBe(302);
  expect(target.hits()).toBe(0);
});

test('загрузка документа идёт через сетевой слой: локальный сервер в локальном режиме отвечает, чужая схема отклоняется', async () => {
  const srv = await httpServer((_req, res) => res.writeHead(200, { 'content-type': 'application/json' }).end('{"issuer":"x"}'));
  expect(await safeFetchJson(new URL(`http://127.0.0.1:${srv.port}/doc`), { timeoutMs: 2000, maxBytes: 1000, allowLoopback: true })).toEqual({ issuer: 'x' });
  await expect(createGuardedFetch({ allowLoopback: true })('ftp://127.0.0.1/x')).rejects.toBeInstanceOf(BlockedAddressError);
  await expect(createGuardedFetch({ allowLoopback: false, resolve: async () => ['203.0.113.10'] })('http://id.smartup.example/x')).rejects.toBeInstanceOf(BlockedAddressError);
});

// --- Итоговая проверка волны 1: замечания F5, F6, F7 ---

test('внешний адрес проходит проверку при соединении и доходит до сокета в том виде, которого ждёт Node (F6)', async () => {
  const lookup = guardedLookup(async () => ['203.0.113.10', '2001:db8::10']);
  // Оба вида ответа: списком (Node просит его при выборе семейства адресов) и одним адресом.
  const all = await new Promise((done) => lookup('id.smartup.example', { all: true }, (error, addresses) => done([error, addresses])));
  expect(all).toEqual([null, [{ address: '203.0.113.10', family: 4 }, { address: '2001:db8::10', family: 6 }]]);
  const one = await new Promise((done) => lookup('id.smartup.example', {}, (error, address, family) => done([error, address, family])));
  expect(one).toEqual([null, '203.0.113.10', 4]);
  // Настоящий сокет принимает ответ: событие lookup несёт проверенный адрес. Соединение с адресом из
  // документации не состоится, сокет закрывается сразу.
  const seen = await new Promise<string[]>((done) => {
    const addresses: string[] = [];
    const socket = connect({ host: 'id.smartup.example', port: 443, lookup, autoSelectFamily: true });
    socket.on('lookup', (_error, address) => {
      addresses.push(String(address));
      socket.destroy();
      done(addresses);
    });
    socket.on('error', () => done(addresses));
  });
  expect(seen).toContain('203.0.113.10');
});

test('слой только читает: запрос с телом или готовым объектом Request отклоняется, а не уходит без тела (F5)', async () => {
  const srv = await httpServer((_req, res) => res.writeHead(200).end('ok'));
  const local = createGuardedFetch({ allowLoopback: true });
  const url = `http://127.0.0.1:${srv.port}/x`;
  await expect(local(url, { method: 'POST', body: 'данные' })).rejects.toThrow('только читает');
  await expect(local(new Request(url, { method: 'DELETE' }))).rejects.toThrow('только читает');
  await expect(local(url, { method: 'POST' })).rejects.toThrow('только читает');
  expect(srv.hits()).toBe(0);
  expect((await local(url, { method: 'HEAD' })).status).toBe(200);
});

test('адреса IPv6 с внутренним адресом IPv4 и устаревшие локальные закрыты (F7)', () => {
  for (const address of ['::7f00:1', '::127.0.0.1', '::a00:5', 'fec0::1', 'feff::1', '::ffff:0:7f00:1', '::ffff:0:10.0.0.5'])
    expect(isPrivateAddress(address), address).toBe(true);
  for (const address of ['2001:db8::10', '2a00:1450:4001::1', '203.0.113.10']) expect(isPrivateAddress(address), address).toBe(false);
});
