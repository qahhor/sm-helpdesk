import { sql } from 'drizzle-orm';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { setSlowTxMsForTests, withActor } from '@/db/with-actor';
import { setLogSinkForTests } from '@/lib/log';
import { enqueueTx, outboxState } from '@/modules/hdn/api/outbox';
import { pools } from './helpers/db';
import { type Fixture, seedTwoOrgs } from './isolation/fixture';

// Измерения для эксплуатации (аудит 23.11.2026, находки O1 и P4): медленная транзакция и состояние очереди исходящих.

const SYSTEM = { type: 'system', job: 'outbox.dispatch' } as const;
let f: Fixture;
let events: [string, string, Record<string, unknown>][];
beforeEach(async () => {
  f = await seedTwoOrgs();
  events = [];
  setLogSinkForTests((level, event, fields) => events.push([level, event, fields ?? {}]));
});
afterEach(() => {
  setLogSinkForTests(null);
  setSlowTxMsForTests(null);
});

test('медленная транзакция пишет db.slow_tx с длительностью и актором, без текста запроса и значений', async () => {
  setSlowTxMsForTests(50);
  await withActor(f.aUser.actor, (tx) => tx.execute(sql`select 1`));
  expect(events.filter(([, event]) => event === 'db.slow_tx')).toEqual([]);
  await withActor(f.l1.actor, (tx) => tx.execute(sql`select pg_sleep(0.08), ${'секретное значение'}::text`));
  const slow = events.filter(([, event]) => event === 'db.slow_tx');
  expect(slow).toHaveLength(1);
  expect(slow[0]![0]).toBe('warn');
  expect(slow[0]![2]).toMatchObject({ actor: 'staff' });
  expect(Number(slow[0]![2].ms)).toBeGreaterThanOrEqual(50);
  expect(JSON.stringify(slow)).not.toContain('секретное');
  expect(JSON.stringify(slow)).not.toContain('pg_sleep');
});

test('системная транзакция называет задачу', async () => {
  setSlowTxMsForTests(0);
  await withActor(SYSTEM, (tx) => tx.execute(sql`select 1`));
  expect(events.find(([, event]) => event === 'db.slow_tx')?.[2]).toMatchObject({ actor: 'system', job: 'outbox.dispatch' });
});

test('состояние очереди исходящих: ждущие, не отправленные и задержка самой старой ждущей строки', async () => {
  await pools.root.query(`delete from hdn_outbox`);
  const now = new Date();
  expect(await outboxState(SYSTEM, now)).toEqual({ queued: 0, failed: 0, lagSec: 0 });
  const item = {
    channel: 'email',
    recipient: { kind: 'user', userId: f.aUser.userId },
    template: 'ticket_resolved',
    payload: { template: 'ticket_resolved', number: f.tickets.aOrg.number, title: 'x', url: '/tickets' },
    ticketId: f.tickets.aOrg.ticketId,
  } as const;
  const [a, b, c] = await withActor(SYSTEM, async (tx) => [await enqueueTx(tx, item), await enqueueTx(tx, item), await enqueueTx(tx, item)]);
  await pools.root.query(`update hdn_outbox set next_attempt_on = $2 where outbox_id = $1`, [a, new Date(now.getTime() - 400_000)]);
  // Строка с будущим сроком (пауза перед повтором) задержкой не считается.
  await pools.root.query(`update hdn_outbox set next_attempt_on = $2 where outbox_id = $1`, [b, new Date(now.getTime() + 600_000)]);
  await pools.root.query(`update hdn_outbox set status = 'failed' where outbox_id = $1`, [c]);
  const state = await outboxState(SYSTEM, now);
  expect(state.queued).toBe(2);
  expect(state.failed).toBe(1);
  expect(state.lagSec).toBeGreaterThanOrEqual(399);
  expect(state.lagSec).toBeLessThanOrEqual(401);
});
