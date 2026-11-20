import { createServer, type Socket } from 'node:net';
import { Pool } from 'pg';
import { expect, test } from 'vitest';
import { pingDb, pingPool } from '@/db/client';
import { isDatabaseReady } from '@/modules/hdc/api';
import { healthResponse, readyResponse } from '@/modules/hdc/util';

test('база доступна: 200', async () => {
  const res = await readyResponse(() => pingDb(2000));
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ status: 'ready', checks: { db: 'ok' } });
  expect(res.headers.get('cache-control')).toBe('no-store');
});

test('сервис модуля проверяет оба подключения к базе', async () => {
  expect(await isDatabaseReady()).toBe(true);
});

test('база недоступна: 503 не дольше чем за 3 секунды, без подробностей', async () => {
  const dead = new Pool({ connectionString: 'postgres://hub_app:x@127.0.0.1:1/hub' });
  const started = Date.now();
  const res = await readyResponse(() => pingPool(dead, 2000));
  expect(res.status).toBe(503);
  expect(Date.now() - started).toBeLessThan(3000);
  const body = await res.text();
  expect(JSON.parse(body)).toEqual({ status: 'not_ready', checks: { db: 'fail' } });
  expect(body).not.toMatch(/ECONNREFUSED|127\.0\.0\.1|hub_app/);
  expect(res.headers.get('cache-control')).toBe('no-store');
  await dead.end();
});

test('база принимает соединение и молчит: ответ приходит по истечении предела', async () => {
  const sockets: Socket[] = [];
  const silent = createServer((socket) => sockets.push(socket));
  await new Promise<void>((resolve) => silent.listen(0, '127.0.0.1', resolve));
  const { port } = silent.address() as { port: number };
  const hung = new Pool({ connectionString: `postgres://hub_app:x@127.0.0.1:${port}/hub` });
  try {
    const started = Date.now();
    expect(await pingPool(hung, 300)).toBe(false);
    expect(Date.now() - started).toBeLessThan(1500);
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => silent.close(resolve));
    await hung.end().catch(() => {});
  }
});

test('проверка с ошибкой внутри считается отказом, а не падением', async () => {
  const res = await readyResponse(async () => {
    throw new Error('секретная подробность');
  });
  expect(res.status).toBe(503);
  expect(await res.text()).not.toMatch(/секретная/);
});

test('health не зависит от базы', async () => {
  const res = healthResponse();
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ status: 'ok' });
  expect(res.headers.get('cache-control')).toBe('no-store');
});

test('зависшая база не отнимает соединения у приложения (ревью I7)', async () => {
  // Сервер завершает вход и дальше молчит: так выглядит зависшая база или оборванная сеть.
  const sockets: Socket[] = [];
  const stalled = createServer((socket) => {
    sockets.push(socket);
    socket.once('data', () => socket.write(Buffer.from([0x52, 0, 0, 0, 8, 0, 0, 0, 0, 0x5a, 0, 0, 0, 5, 0x49])));
  });
  await new Promise<void>((resolve) => stalled.listen(0, '127.0.0.1', resolve));
  const { port } = stalled.address() as { port: number };
  const pool = new Pool({ connectionString: `postgres://hub_app:x@127.0.0.1:${port}/hub`, max: 3 });
  try {
    for (let i = 0; i < 5; i++) expect(await pingPool(pool, 150)).toBe(false);
    expect(pool.totalCount - pool.idleCount).toBe(0);
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => stalled.close(resolve));
    await pool.end().catch(() => {});
  }
});

test('готовность отказывает, если приложение подключено не под ролью hub_app (ревью I1)', async () => {
  const { isRestrictedAppRole } = await import('@/db/client');
  const { pools } = await import('./helpers/db');
  expect(await pingPool(pools.app, 2000, isRestrictedAppRole)).toBe(true);
  expect(await pingPool(pools.owner, 2000, isRestrictedAppRole)).toBe(false);
});

test('готовность проверяет оба подключения: приложения и аутентификации', async () => {
  const { pools } = await import('./helpers/db');
  expect(await isDatabaseReady()).toBe(true);
  const dead = new Pool({ connectionString: 'postgres://hub_auth:x@127.0.0.1:1/hub' });
  try {
    expect(await isDatabaseReady({ authPool: dead })).toBe(false);
    expect(await isDatabaseReady({ appPool: dead })).toBe(false);
    // Подключение аутентификации под чужой ролью тоже отказ.
    expect(await isDatabaseReady({ authPool: pools.app })).toBe(false);
    expect(await isDatabaseReady({ authPool: pools.owner })).toBe(false);
  } finally {
    await dead.end().catch(() => {});
  }
});
