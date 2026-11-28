import { expect, test } from 'vitest';
import { aiConfig } from '@/modules/hda/api/config';
import { readSetting, readSettings } from '@/modules/hdc/api';
import { readTimings } from '@/modules/hdt/api/timings';
import { staffCtx, staffWithRole } from './helpers/auth';
import { pools } from './helpers/db';
import { countTx } from './helpers/tx';

// Настройки читаются одной выборкой (проверка качества, Q3): раньше aiConfig() открывал по транзакции на каждую из
// одиннадцати настроек при пуле в десять соединений, readTimings по одной на каждый срок.

const set = (code: string, value: unknown) => pools.root.query(`insert into hdc_settings (code, value) values ($1, $2)`, [code, JSON.stringify(value)]);

test('readSettings: несколько кодов одной транзакцией, отсутствующего кода в ответе нет', async () => {
  await set('test.one', 1);
  await set('test.two', { a: 'b' });
  const { result, app } = await countTx(() => readSettings(['test.one', 'test.two', 'test.missing']));
  expect(app).toBe(1);
  expect([...result.entries()].sort()).toEqual([
    ['test.one', 1],
    ['test.two', { a: 'b' }],
  ]);
  expect((await countTx(() => readSettings([]))).app).toBe(0);
  expect(await readSetting('test.one')).toBe(1);
});

test('aiConfig: одна транзакция на все настройки, значения и умолчания прежние', async () => {
  await set('ai.user_daily_limit', 7);
  await set('ai.org_daily_limit', 'не число');
  const { result, app, nested } = await countTx(() => aiConfig());
  expect(app).toBe(1);
  expect(nested).toEqual([]);
  expect(result.userDailyLimit).toBe(7);
  // Негодное значение в базе заменяется умолчанием, как раньше.
  expect(typeof result.orgDailyLimit).toBe('number');
});

test('readTimings: одна транзакция на четыре срока', async () => {
  const admin = staffCtx(await staffWithRole('admin'));
  const { result, app } = await countTx(() => readTimings(admin));
  expect(app).toBe(1);
  expect(Object.keys(result).length).toBeGreaterThanOrEqual(4);
});
