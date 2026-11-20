import { EnvError, getEnv } from './env';

// Проверка окружения при запуске. Сервер с неверными переменными не должен принимать запросы:
// процесс завершается с кодом 1, и это видно оркестратору и в журнале.
try {
  getEnv();
} catch (error) {
  if (!(error instanceof EnvError)) throw error;
  console.error(error.message);
  process.exit(1);
}
