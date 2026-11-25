import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { runCli } from '@/cli/commands';
import { MemoryTelegramBot, setTelegramBotForTests } from '@/modules/hdn/telegram';

function fakeIo() {
  const lines: string[] = [];
  const errors: string[] = [];
  return {
    lines,
    errors,
    io: {
      env: { HUB_URL: 'http://localhost:3000' } as Record<string, string | undefined>,
      out: (line: string) => void lines.push(line),
      err: (line: string) => void errors.push(line),
      readSecret: async () => {
        throw new Error('секрет не должен запрашиваться');
      },
    },
  };
}

test('секрет нельзя передать аргументом', async () => {
  for (const argv of [
    ['server:add', '--code', 'x', '--client-secret', 'abc'],
    ['server:add', '--code', 'x', '--client-secret=abc'],
  ]) {
    const { io, errors } = fakeIo();
    expect(await runCli(argv, io)).toBe(2);
    expect(errors.join('\n')).toContain('HUB_OAUTH_CLIENT_SECRET');
    expect(errors.join('\n')).not.toContain('abc');
  }
});

test('неизвестная команда, лишний ключ и нехватка аргументов дают код 2 и справку', async () => {
  for (const argv of [
    [],
    ['nope'],
    ['staff:create', '--email', 'a@smartup.example'],
    ['staff:create', '--email', 'a@smartup.example', '--name', 'A', '--role', 'care', '--extra', '1'],
    ['server:disable'],
    ['staff:reset'],
  ]) {
    const { io, errors } = fakeIo();
    expect(await runCli(argv, io), argv.join(' ')).toBe(2);
    expect(errors.join('\n')).toContain('hub <команда>');
  }
});

test('справка перечисляет все команды', async () => {
  const { io, lines } = fakeIo();
  expect(await runCli(['--help'], io)).toBe(0);
  for (const name of ['staff:create', 'staff:reset', 'server:add', 'server:list', 'server:disable', 'signatures:test']) expect(lines.join('\n')).toContain(name);
});

// --- Бот Telegram (задача 16) ---

afterEach(() => setTelegramBotForTests(null));

test('вебхук бота ставится на адрес портала с секретом из окружения', async () => {
  const bot = new MemoryTelegramBot();
  setTelegramBotForTests(bot);
  const { io, lines } = fakeIo();
  io.env = { HUB_URL: 'https://hub.smartup24.com', TELEGRAM_BOT_TOKEN: '1:t', TELEGRAM_WEBHOOK_SECRET: MemoryTelegramBot.SECRET };
  expect(await runCli(['telegram:set-webhook'], io)).toBe(0);
  expect(bot.webhooks).toEqual([{ url: 'https://hub.smartup24.com/api/webhooks/telegram', secret: MemoryTelegramBot.SECRET }]);
  expect(lines.join('\n')).toContain('https://hub.smartup24.com/api/webhooks/telegram');
  expect(lines.join('\n')).not.toContain(MemoryTelegramBot.SECRET);
  expect(await runCli(['telegram:info'], io)).toBe(0);
  expect(lines.at(-1)).toBe('Бот включён: @hub_test_bot');
});

test('без токена бота команда вебхука отказывает и не обращается к Telegram', async () => {
  const bot = new MemoryTelegramBot();
  setTelegramBotForTests(bot);
  const { io, errors } = fakeIo();
  expect(await runCli(['telegram:set-webhook'], io)).toBe(1);
  expect(errors.join('\n')).toContain('TELEGRAM_BOT_TOKEN');
  expect(bot.webhooks).toEqual([]);
});

// --- Сигнатуры ошибок на корпусе (план M5, задача 8) ---

test('signatures:test: синтетический корпус каталога tests/fixtures/errors группируется по меткам, код 0', async () => {
  const { io, lines } = fakeIo();
  expect(await runCli(['signatures:test'], io)).toBe(0);
  const out = lines.join('\n');
  expect(out).toContain('Корпус tests/fixtures/errors: файлов 1, текстов 15.');
  expect(out).toContain('ORA-20001 | документ №<n> от <n>.<n> не найден');
  expect(out).toContain('Итог: текстов 15, групп 7, без сигнатуры 1.');
  expect(out).toContain('Метки и сигнатуры совпадают.');
});

test('signatures:test: распавшаяся и смешанная метки дают код 1 и названы в сводке; нет каталога: код 1', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'corpus-'));
  try {
    writeFileSync(join(dir, 'a.txt'), '[x] ORA-20001: Документ 1 не найден\n\n[x] ORA-20001: Период 1 закрыт\n\n[y] ORA-20001: Документ 2 не найден\n');
    const { io, lines } = fakeIo();
    expect(await runCli(['signatures:test', '--dir', dir], io)).toBe(1);
    expect(lines.join('\n')).toContain('Одна ошибка дала несколько сигнатур, метки: x.');
    expect(lines.join('\n')).toContain('Разные ошибки дали одну сигнатуру:');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  const { io, errors } = fakeIo();
  expect(await runCli(['signatures:test', '--dir', join(tmpdir(), 'нет-такого-каталога-corpus')], io)).toBe(1);
  expect(errors.join('\n')).toContain('Каталог не прочитан');
});
