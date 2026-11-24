import { afterEach, beforeEach, expect, test } from 'vitest';
import { syncDevTasks } from '@/modules/hdw/api/dev-task-jobs';
import { type DevTracker, setDevTrackerForTests } from '@/modules/hdw/dev-tracker';
import { DevTrackerUnavailableError } from '@/modules/hdw/dev-tracker/smartup';
import { pools } from './helpers/db';
import { seedTwoOrgs } from './isolation/fixture';

// Исправления по независимой проверке вехи M8: опрос таск-менеджера (находка I4). Задачи, которые не читаются
// постоянно, не должны навсегда закрывать опрос остальных.

const SYSTEM = { type: 'system', job: 'devtasks.sync' } as const;
const MINUTE = 60_000;
/** Какие задачи таск-менеджер не отдаёт и с каким кодом сбоя. */
let broken: Map<string, string>;
let asked: string[];

beforeEach(async () => {
  await seedTwoOrgs();
  broken = new Map();
  asked = [];
  const tracker: DevTracker = {
    createTask: async () => {
      throw new Error('в этом тесте задачи не создаются');
    },
    getTask: async (ref) => {
      asked.push(ref);
      const code = broken.get(ref);
      if (code) throw new DevTrackerUnavailableError(code);
      return { ref, url: `https://tasks.smartup.example/${ref}`, status: 'in_progress' };
    },
  };
  setDevTrackerForTests({ settings: { mode: 'smartup', url: 'https://tasks.smartup.example', token: 'token', webhookSecret: 'secret' }, tracker });
});
afterEach(() => setDevTrackerForTests(null));

/** Открытые задачи режима API: первые bad давно не сверены, остальные сверены позже. Все пора опрашивать. */
async function seedTasks(bad: number, good: number, code: string): Promise<void> {
  for (let i = 1; i <= bad + good; i++) {
    const ref = `${i <= bad ? 'BAD' : 'OK'}-${i}`;
    await pools.root.query(`insert into hdw_dev_tasks (tracker, external_id, url, status, synced_on) values ('smartup', $1, $2, 'todo', now() - make_interval(mins => $3))`, [ref, `https://tasks.smartup.example/${ref}`, 600 - i]);
    if (i <= bad) broken.set(ref, code);
  }
}
const statuses = () => pools.root.query(`select external_id, status from hdw_dev_tasks order by external_id`).then((r) => Object.fromEntries(r.rows.map((row) => [row.external_id as string, row.status as string])));

test('I4: пять задач, которые таск-менеджер не отдаёт постоянно, не останавливают опрос остальных: сбой одной задачи не признак недоступности', async () => {
  await seedTasks(5, 3, 'http_404');
  expect(await syncDevTasks(SYSTEM)).toEqual({ checked: 8, updated: 3, failed: 5, reminded: 0 });
  expect(await statuses()).toMatchObject({ 'OK-6': 'in_progress', 'OK-7': 'in_progress', 'OK-8': 'in_progress', 'BAD-1': 'todo' });
});

test('I4: таск-менеджер не отвечает на пяти задачах подряд: запуск останавливается, а следующий начинает с задач, которые ещё не пробовал', async () => {
  await seedTasks(5, 3, 'timeout');
  // Первый запуск: пять сбоев сети подряд, остальные задачи не опрошены.
  expect(await syncDevTasks(SYSTEM)).toEqual({ checked: 5, updated: 0, failed: 5, reminded: 0 });
  expect(asked).toEqual(['BAD-1', 'BAD-2', 'BAD-3', 'BAD-4', 'BAD-5']);
  // Момент попытки записан, момент сверки прежний: задача по-прежнему считается несверенной.
  const tried = (await pools.root.query(`select count(*)::int as n from hdw_dev_tasks where sync_attempted_on is not null and synced_on < now() - interval '9 hours'`)).rows[0].n;
  expect(tried).toBe(5);
  // Следующий запуск: неудачные задачи ушли в конец очереди, исправные опрошены первыми.
  asked = [];
  expect(await syncDevTasks(SYSTEM, { now: new Date(Date.now() + MINUTE) })).toEqual({ checked: 8, updated: 3, failed: 5, reminded: 0 });
  expect(asked.slice(0, 3)).toEqual(['OK-6', 'OK-7', 'OK-8']);
  expect(await statuses()).toMatchObject({ 'OK-6': 'in_progress', 'OK-7': 'in_progress', 'OK-8': 'in_progress' });
});
