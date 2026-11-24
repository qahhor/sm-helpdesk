import './wiring';
import { EnvError, getEnv } from './env';
import { configureLog } from './lib/log';
import { LOOPBACK_HOSTS } from './security/outbound';
import { installOutboundGuard } from './security/outbound-dispatcher';

// Проверка окружения при запуске. Сервер с неверными переменными не должен принимать запросы:
// процесс завершается с кодом 1, и это видно оркестратору и в журнале.
try {
  const env = getEnv();
  configureLog({ level: env.LOG_LEVEL, json: (env.LOG_FORMAT ?? (process.env.NODE_ENV === 'production' ? 'json' : 'text')) === 'json' });
  // Запросы библиотеки входа к серверам Smartup проверяют адрес при соединении (решение 0041, вопрос 18).
  installOutboundGuard({ allowLoopback: LOOPBACK_HOSTS.has(new URL(env.HUB_URL).hostname) });
} catch (error) {
  if (!(error instanceof EnvError)) throw error;
  console.error(error.message);
  process.exit(1);
}
