import { execFileSync } from 'node:child_process';
import { dbRows } from './helpers/db';

// Перед браузерными тестами база должна быть готова: /api/ready проверяет её.
// В CI базу поднимает сама задача (сервис postgres, pnpm db:bootstrap, pnpm db:migrate).
// На машине разработчика сценарий поднимает базу из compose.yaml, создаёт роли и применяет миграции.
export default async function globalSetup() {
  if (process.env.CI) return;
  execFileSync(process.execPath, ['scripts/dev-up.mjs', '--prepare'], { stdio: 'inherit' });
  // База разработки переживает прогоны: счётчики частоты прошлого прогона (все запросы идут с одного адреса)
  // не должны блокировать этот. В CI база каждый раз новая.
  await dbRows(`delete from hdc_rate_limits`);
}
