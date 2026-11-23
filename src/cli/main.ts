import '@/wiring';
import { closeConnections } from '@/modules/hdu/api/connections';
import { type CliIo, runCli } from './commands';

// Точка входа команды hub. Собирается в один файл dist/hub.mjs (scripts/build-cli.mjs).
// В образе: node hub.mjs <команда>. В разработке: pnpm hub <команда>.

/** Ввод строки без отображения: секрет не остаётся на экране и в записи терминала. */
function readSecret(prompt: string): Promise<string> {
  const input = process.stdin;
  process.stderr.write(prompt);
  // Не терминал (секрет передан через канал): читается первая строка.
  if (!input.isTTY) {
    return new Promise((resolve) => {
      let data = '';
      input.setEncoding('utf8');
      input.on('data', (chunk) => {
        data += chunk;
      });
      input.on('end', () => resolve(data.split(/\r?\n/)[0] ?? ''));
    });
  }
  return new Promise((resolve, reject) => {
    let value = '';
    input.setRawMode(true);
    input.setEncoding('utf8');
    input.resume();
    const done = (result: string | null) => {
      input.setRawMode(false);
      input.pause();
      input.removeListener('data', onData);
      process.stderr.write('\n');
      if (result === null) reject(new Error('Ввод прерван'));
      else resolve(result);
    };
    const onData = (chunk: string) => {
      for (const char of chunk) {
        if (char === '\r' || char === '\n') return done(value);
        if (char === '\u0003') return done(null);
        if (char === '\u007f' || char === '\b') value = value.slice(0, -1);
        else value += char;
      }
    };
    input.on('data', onData);
  });
}

const io: CliIo = {
  env: process.env,
  out: (line) => process.stdout.write(`${line}\n`),
  err: (line) => process.stderr.write(`${line}\n`),
  readSecret,
};

let code = 1;
try {
  code = await runCli(process.argv.slice(2), io);
} finally {
  await closeConnections();
}
process.exit(code);
