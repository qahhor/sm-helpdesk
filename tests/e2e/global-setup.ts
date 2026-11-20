import { execFileSync } from 'node:child_process';

// Перед браузерными тестами база должна быть готова: /api/ready проверяет её.
// В CI базу поднимает сама задача (сервис postgres, pnpm db:bootstrap, pnpm db:migrate).
// На машине разработчика сценарий поднимает базу из compose.yaml, создаёт роли и применяет миграции.
export default function globalSetup() {
  if (process.env.CI) return;
  execFileSync(process.execPath, ['scripts/dev-up.mjs', '--prepare'], { stdio: 'inherit' });
}
