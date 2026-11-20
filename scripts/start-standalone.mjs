// Запуск собранного приложения (output: 'standalone').
// Next.js не кладёт public и .next/static в .next/standalone: их копирует этот сценарий.
import { spawn } from 'node:child_process';
import { cpSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const standalone = join(root, '.next', 'standalone');

if (!existsSync(join(standalone, 'server.js'))) {
  console.error('Сборка не найдена. Сначала выполните: pnpm build');
  process.exit(1);
}

cpSync(join(root, '.next', 'static'), join(standalone, '.next', 'static'), { recursive: true });
if (existsSync(join(root, 'public')))
  cpSync(join(root, 'public'), join(standalone, 'public'), { recursive: true });

const child = spawn(process.execPath, ['server.js'], {
  cwd: standalone,
  stdio: 'inherit',
  env: { ...process.env, HOSTNAME: process.env.HOSTNAME ?? '0.0.0.0', PORT: process.env.PORT ?? '3000' },
});
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
