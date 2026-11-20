import 'server-only';
import { closeAuthPool } from '@/db/auth-client';
import { closeAppPool } from '@/db/client';

/** Закрывает соединения с базой. Нужна команде консоли: без этого процесс не завершится сам. */
export async function closeConnections(): Promise<void> {
  await Promise.allSettled([closeAuthPool(), closeAppPool()]);
}
