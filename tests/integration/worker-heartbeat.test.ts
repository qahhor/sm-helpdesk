import { PgBoss } from 'pg-boss';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { beatWorker, bossOptions, JOB_NAMES, WORKER_STALE_SEC, workerReadyResponse } from '@/modules/hdc/api';
import { SCHEDULES, startWorker } from '@/worker/main';
import { QUEUES } from '../../scripts/db/pgboss.mjs';
import { appUrl, asActor, pools } from './helpers/db';
import { seedTwoOrgs } from './isolation/fixture';

// Фоновый процесс виден снаружи (план подготовки M9, задача 3, решение 5; ТЗ 13.8). Процесс раз в минуту ставит
// отметку, адрес /api/ready/worker отвечает 503 при отметке старше 3 минут. /api/ready от него не зависит: по нему
// Caddy делит запросы, и сбой фонового процесса не снимает портал.

const SYSTEM = { type: 'system', job: 'ops.heartbeat' } as const;
const MINUTE = 60_000;

beforeEach(async () => {
  await pools.root.query('delete from hdc_ops_heartbeats');
  await pools.owner.query('delete from pgboss.job');
});

let stop: (() => Promise<void>) | undefined;
afterEach(async () => {
  await stop?.();
  stop = undefined;
});

test('порог отметки 3 минуты, отметка раз в минуту по расписанию фонового процесса', () => {
  expect(WORKER_STALE_SEC).toBe(180);
  expect(SCHEDULES).toContainEqual({ name: 'ops.heartbeat', cron: '* * * * *', tz: 'UTC' });
  expect(JOB_NAMES).toContain('ops.heartbeat');
  expect(QUEUES).toHaveProperty('ops.heartbeat');
});

test('свежая отметка: 200; отметка старше 3 минут и её отсутствие: 503; ответ без подробностей', async () => {
  const now = new Date();
  const none = await workerReadyResponse(now);
  expect(none.status).toBe(503);
  expect(await none.json()).toEqual({ status: 'not_ready', checks: { worker: 'fail' } });

  await beatWorker(SYSTEM, new Date(now.getTime() - 2 * MINUTE));
  const fresh = await workerReadyResponse(now);
  expect(fresh.status).toBe(200);
  expect(fresh.headers.get('cache-control')).toBe('no-store');
  // Ни времени отметки, ни возраста: адрес открыт без входа.
  expect(await fresh.text()).toBe(JSON.stringify({ status: 'ready', checks: { worker: 'ok' } }));

  const stale = await workerReadyResponse(new Date(now.getTime() + 2 * MINUTE));
  expect(stale.status).toBe(503);
  const body = await stale.text();
  expect(JSON.parse(body)).toEqual({ status: 'not_ready', checks: { worker: 'fail' } });
  expect(body).not.toMatch(/\d{4}-\d{2}-\d{2}|seconds|age/);
});

test('повторная отметка обновляет одну строку', async () => {
  const now = Date.now();
  await beatWorker(SYSTEM, new Date(now - 10 * MINUTE));
  await beatWorker(SYSTEM, new Date(now));
  const rows = (await pools.root.query(`select process, beat_on from hdc_ops_heartbeats`)).rows;
  expect(rows).toHaveLength(1);
  expect(rows[0].process).toBe('worker');
  expect(new Date(rows[0].beat_on).getTime()).toBe(now);
  expect((await workerReadyResponse(new Date(now))).status).toBe(200);
});

test('база недоступна или отметку не прочитать: 503, а не ошибка', async () => {
  const res = await workerReadyResponse(new Date(), async () => {
    throw new Error('ECONNREFUSED 127.0.0.1:5432');
  });
  expect(res.status).toBe(503);
  expect(await res.text()).not.toContain('ECONNREFUSED');
});

test('фоновый процесс ставит отметку при запуске и задачей ops.heartbeat', async () => {
  const worker = await startWorker({ pollingIntervalSeconds: 0.5, schedules: false });
  stop = worker.stop;
  // Отметка при запуске: после выкладки адрес не отвечает 503 до первой минуты расписания.
  expect((await workerReadyResponse(new Date())).status).toBe(200);
  await pools.root.query(`update hdc_ops_heartbeats set beat_on = now() - interval '10 minutes'`);
  expect((await workerReadyResponse(new Date())).status).toBe(503);
  // Задача ставится, как её ставит расписание pg-boss.
  const sender = new PgBoss(bossOptions(appUrl, 'sender'));
  sender.on('error', () => {});
  await sender.start();
  try {
    await sender.send('ops.heartbeat', {});
  } finally {
    await sender.stop({ graceful: false });
  }
  const until = Date.now() + 15_000;
  while ((await workerReadyResponse(new Date())).status !== 200) {
    if (Date.now() > until) throw new Error('отметка задачей не поставлена');
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
});

test('клиент и сотрудник отметок не видят и не ставят', async () => {
  const f = await seedTwoOrgs();
  await beatWorker(SYSTEM, new Date());
  for (const actor of [f.aAdmin.actor, f.adminStaff.actor, f.care.actor]) {
    expect((await asActor(pools.app, actor, (c) => c.query('select * from hdc_ops_heartbeats'))).rows).toEqual([]);
    await expect(asActor(pools.app, actor, (c) => c.query(`insert into hdc_ops_heartbeats (process, beat_on) values ('fake', now())`))).rejects.toThrow(/row-level security/);
  }
});
