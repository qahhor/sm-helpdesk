import { describe, expect, test } from 'vitest';
import { formatLine, installJsonConsole, logEvent, setLogSinkForTests, runJobSteps, timedJob } from '@/lib/log';

// Журнал процесса строками JSON (аудит 23.11.2026, находки O1 и S4; ТЗ 13.8): время, уровень, событие, поля.
// Поля с именами секретов вырезаются, текст ограничен по длине.

const NOW = new Date('2026-11-23T10:00:00.000Z');

test('строка журнала: JSON с временем, уровнем, событием и полями', () => {
  const line = JSON.parse(formatLine('info', 'job.done', { job: 'outbox.dispatch', ms: 42 }, NOW));
  expect(line).toEqual({ time: '2026-11-23T10:00:00.000Z', level: 'info', event: 'job.done', job: 'outbox.dispatch', ms: 42 });
});

test('поля с именами секретов вырезаются на любой глубине, ошибка пишется именем и текстом', () => {
  const line = JSON.parse(
    formatLine('error', 'x', { token: 'abc', nested: { clientSecret: 's', Authorization: 'Bearer 1', ok: 1 }, password: 'p', error: new TypeError('плохо') }, NOW),
  );
  expect(line.token).toBe('[вырезано]');
  expect(line.nested).toEqual({ clientSecret: '[вырезано]', Authorization: '[вырезано]', ok: 1 });
  expect(line.password).toBe('[вырезано]');
  expect(line.error).toMatchObject({ name: 'TypeError', message: 'плохо' });
});

test('служебные поля строки нельзя перекрыть, длинный текст обрезается, строка одна', () => {
  const line = formatLine('warn', 'e', { level: 'error', time: 'x', msg: `a\n${'б'.repeat(5000)}` }, NOW);
  expect(line).not.toContain('\n');
  const parsed = JSON.parse(line);
  expect(parsed.level).toBe('warn');
  expect(parsed.time).toBe('2026-11-23T10:00:00.000Z');
  expect(parsed.msg.length).toBeLessThanOrEqual(2003);
});

test('installJsonConsole переводит console в строки JSON, уровень из метода', () => {
  const out: string[] = [];
  const noop: (...args: unknown[]) => void = () => {};
  const fake = { debug: noop, info: noop, log: noop, warn: noop, error: noop };
  installJsonConsole(fake, (line) => out.push(line), () => NOW);
  fake.error('Письмо %s не отправлено: %s', 'login-link', 'код 500');
  fake.info('Фоновый процесс запущен');
  expect(out.map((l) => JSON.parse(l))).toEqual([
    { time: NOW.toISOString(), level: 'error', event: 'log', msg: 'Письмо login-link не отправлено: код 500' },
    { time: NOW.toISOString(), level: 'info', event: 'log', msg: 'Фоновый процесс запущен' },
  ]);
});

test('logEvent отдаёт событие в приёмник тестов', () => {
  const seen: unknown[] = [];
  setLogSinkForTests((level, event, fields) => seen.push([level, event, fields]));
  try {
    logEvent('warn', 'db.slow_tx', { ms: 300 });
  } finally {
    setLogSinkForTests(null);
  }
  expect(seen).toEqual([['warn', 'db.slow_tx', { ms: 300 }]]);
});

test('timedJob пишет длительность задачи: быстрая на уровне debug, от секунды на info, сбой на error и пробрасывается', async () => {
  const seen: [string, string, Record<string, unknown>][] = [];
  setLogSinkForTests((level, event, fields) => seen.push([level, event, fields ?? {}]));
  let clock = 0;
  const tick = () => clock;
  try {
    await timedJob('fast', async () => void (clock += 20), tick);
    await timedJob('slow', async () => void (clock += 1500), tick);
    await expect(timedJob('bad', async () => {
      clock += 5;
      throw new RangeError('сбой шага');
    }, tick)).rejects.toThrow('сбой шага');
  } finally {
    setLogSinkForTests(null);
  }
  expect(seen).toEqual([
    ['debug', 'job.done', { job: 'fast', ms: 20 }],
    ['info', 'job.done', { job: 'slow', ms: 1500 }],
    ['error', 'job.failed', { job: 'bad', ms: 5, error: new RangeError('сбой шага') }],
  ]);
});

test('итоговая проверка W0, M1: стек ошибки пишется, полезные поля не вырезаются, сбой поля не роняет журнал', () => {
  const error = new RangeError('сбой');
  const line = JSON.parse(formatLine('error', 'job.failed', { error, tokenId: 'tok_1', botTokenSaved: true, scanSignature: 'Eicar-Test', apiKey: 'k' }, NOW));
  expect(line.error.stack).toContain('RangeError');
  expect(line.tokenId).toBe('tok_1');
  expect(line.botTokenSaved).toBe(true);
  expect(line.scanSignature).toBe('Eicar-Test');
  expect(line.apiKey).toBe('[вырезано]');
  const broken = {
    get bad(): string {
      throw new Error('поле недоступно');
    },
  };
  expect(() => formatLine('info', 'x', { broken }, NOW)).not.toThrow();
  // Большой объект не раздувает строку.
  expect(formatLine('info', 'x', { big: Buffer.alloc(5000) }, NOW).length).toBeLessThan(3000);
});

// Независимая проверка вехи M8c, находка I4 (решение 0134): шаги минутной задачи не зависят друг от друга.
describe('runJobSteps', () => {
  test('сбой шага не пропускает следующие; ошибка пишется в журнал и пробрасывается после всех шагов', async () => {
    const events: { level: string; event: string; fields?: Record<string, unknown> }[] = [];
    setLogSinkForTests((level, event, fields) => void events.push({ level, event, ...(fields ? { fields } : {}) }));
    const done: string[] = [];
    try {
      await expect(
        runJobSteps('agent.events_dispatch', [
          { step: 'events', run: async () => void done.push('events') },
          {
            step: 'chat',
            run: async () => {
              throw new Error('чат недоступен');
            },
          },
          { step: 'analysis_timeouts', run: async () => void done.push('analysis_timeouts') },
        ]),
      ).rejects.toThrow('чат недоступен');
    } finally {
      setLogSinkForTests(null);
    }
    expect(done).toEqual(['events', 'analysis_timeouts']);
    expect(events).toEqual([{ level: 'error', event: 'job.step_failed', fields: { job: 'agent.events_dispatch', step: 'chat', error: expect.any(Error) } }]);
  });

  test('без сбоев ничего не пишет и не бросает', async () => {
    await expect(runJobSteps('x', [{ step: 'a', run: async () => undefined }])).resolves.toBeUndefined();
  });
});
