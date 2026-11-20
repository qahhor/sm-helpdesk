import { expect, test } from 'vitest';
import { consumeRateLimit, rateKey, resetRateLimit } from '@/modules/hdc/rate-limit';
import { admin, asActor, clientA, pools } from './helpers/db';

const rule = { limit: 5, windowSec: 3600 };
const at = (min: number) => new Date(Date.UTC(2026, 10, 20, 9, min));

test('пять попыток проходят, шестая нет', async () => {
  const key = rateKey('t1', 'User@Example.Test');
  for (let i = 0; i < 5; i++) expect(await consumeRateLimit(key, rule, at(i))).toEqual({ allowed: true, retryAfterSec: 0 });
  expect(await consumeRateLimit(key, rule, at(5))).toEqual({ allowed: false, retryAfterSec: 3600 });
});

test('блокировка длится окно с момента превышения и не продлевается новыми попытками', async () => {
  const key = rateKey('t2', 'a');
  for (let i = 0; i < 6; i++) await consumeRateLimit(key, rule, at(0));
  expect(await consumeRateLimit(key, rule, at(30))).toEqual({ allowed: false, retryAfterSec: 1800 });
  expect((await consumeRateLimit(key, rule, at(59))).allowed).toBe(false);
  expect((await consumeRateLimit(key, rule, at(61))).allowed).toBe(true);
});

test('по истечении окна счёт начинается заново', async () => {
  const key = rateKey('t5', 'a');
  for (let i = 0; i < 3; i++) await consumeRateLimit(key, rule, at(0));
  for (let i = 0; i < 5; i++) expect((await consumeRateLimit(key, rule, at(60))).allowed).toBe(true);
  expect((await consumeRateLimit(key, rule, at(60))).allowed).toBe(false);
});

test('одновременные попытки считаются без потерь', async () => {
  const key = rateKey('t3', 'a');
  const results = await Promise.all(Array.from({ length: 20 }, () => consumeRateLimit(key, rule, at(0))));
  expect(results.filter((r) => r.allowed)).toHaveLength(5);
});

test('сброс возвращает право на попытки', async () => {
  const key = rateKey('t4', 'a');
  for (let i = 0; i < 6; i++) await consumeRateLimit(key, rule, at(0));
  await resetRateLimit(key);
  expect((await consumeRateLimit(key, rule, at(1))).allowed).toBe(true);
});

test('разные ключи считаются отдельно', async () => {
  for (let i = 0; i < 6; i++) await consumeRateLimit(rateKey('t6', 'a'), rule, at(0));
  expect((await consumeRateLimit(rateKey('t6', 'b'), rule, at(0))).allowed).toBe(true);
  expect((await consumeRateLimit(rateKey('t7', 'a'), rule, at(0))).allowed).toBe(true);
});

test('в таблице нет адресов и IP в открытом виде, написание адреса не влияет на ключ', async () => {
  await consumeRateLimit(rateKey('login-link:address', 'Person@Example.Test'), rule);
  const r = await pools.root.query(`select code from hdc_rate_limits where code like 'login-link:address:%'`);
  expect(r.rows).toHaveLength(1);
  expect(r.rows[0].code).toMatch(/^login-link:address:[0-9a-f]{32}$/);
  expect(rateKey('s', ' Person@Example.Test ')).toBe(rateKey('s', 'person@example.test'));
  expect(rateKey('s', 'a')).not.toBe(rateKey('s', 'b'));
});

test('счётчики видит и меняет только система', async () => {
  await consumeRateLimit(rateKey('t8', 'a'), rule);
  for (const actor of [clientA, admin]) {
    expect((await asActor(pools.app, actor, (c) => c.query('select * from hdc_rate_limits'))).rows).toEqual([]);
    expect((await asActor(pools.app, actor, (c) => c.query('delete from hdc_rate_limits'))).rowCount).toBe(0);
    await expect(
      asActor(pools.app, actor, (c) => c.query(`insert into hdc_rate_limits (code, window_on, hits) values ('x', now(), 1)`)),
    ).rejects.toThrow(/row-level security/);
  }
  await expect(pools.auth.query('select 1 from hdc_rate_limits')).rejects.toThrow(/permission denied/);
});
