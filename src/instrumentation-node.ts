import { EnvError, getEnv } from './env';
import { configureLog } from './lib/log';

// Проверка окружения при запуске. Сервер с неверными переменными не должен принимать запросы:
// процесс завершается с кодом 1, и это видно оркестратору и в журнале.
try {
  const env = getEnv();
  configureLog({ level: env.LOG_LEVEL, json: (env.LOG_FORMAT ?? (process.env.NODE_ENV === 'production' ? 'json' : 'text')) === 'json' });
} catch (error) {
  if (!(error instanceof EnvError)) throw error;
  console.error(error.message);
  process.exit(1);
}
