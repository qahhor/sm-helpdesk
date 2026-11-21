import 'server-only';
import { createHmac } from 'node:crypto';
import { env } from '@/env';
import { createLocalHandler, createLocalStorage, type LocalStorage } from './local';
import { createR2Storage } from './r2';
import type { Storage } from './types';

// Выбор хранилища по окружению (решение 0027): r2 на серверах, local на машине разработчика.

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1']);

let override: Storage | null = null;
let r2: Storage | undefined;
let local: LocalStorage | undefined;

/** Ключ подписи ссылок локального хранилища: выводится из секрета сессий, отдельной переменной не нужно. */
const localSecret = () => createHmac('sha256', env.BETTER_AUTH_SECRET).update('hub:local-storage').digest('hex');

function localStorage(): LocalStorage {
  return (local ??= createLocalStorage({ dir: env.FILE_STORAGE_DIR, baseUrl: env.HUB_URL, secret: localSecret() }));
}

export function getStorage(): Storage {
  if (override) return override;
  if (env.FILE_STORAGE !== 'r2') return localStorage();
  // Наличие переменных при r2 проверяет src/env.ts.
  return (r2 ??= createR2Storage({
    endpoint: env.R2_ENDPOINT ?? '',
    bucket: env.R2_BUCKET ?? '',
    accessKeyId: env.R2_ACCESS_KEY_ID ?? '',
    secretAccessKey: env.R2_SECRET_ACCESS_KEY ?? '',
  }));
}

/** Тесты подменяют хранилище (null возвращает настоящее). */
export function setStorageForTests(storage: Storage | null): void {
  override = storage;
}

/** Обработчик /api/uploads/local: работает только при FILE_STORAGE=local и адресе портала на localhost. */
export function handleLocalStorage(request: Request): Promise<Response> {
  const enabled = env.FILE_STORAGE === 'local' && LOCAL_HOSTS.has(new URL(env.HUB_URL).hostname);
  return createLocalHandler({ storage: localStorage(), secret: localSecret(), enabled })(request);
}

export { contentDisposition, type Storage, UPLOAD_LINK_TTL_SEC } from './types';
