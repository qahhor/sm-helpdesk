import 'server-only';
import { eq, lt } from 'drizzle-orm';
import { withActor } from '@/db/with-actor';
import { telegramUpdates } from './schema';

// Модуль hdn, слой core: операции с данными (docs/naming.md, раздел 5).

const SYSTEM = { type: 'system', job: 'telegram.webhook' } as const;

/** Запоминает номер события. Ложь: такое событие уже принято. */
export async function recordUpdate(updateId: number): Promise<boolean> {
  const rows = await withActor(SYSTEM, (tx) =>
    tx.insert(telegramUpdates).values({ updateId }).onConflictDoNothing().returning({ updateId: telegramUpdates.updateId }),
  );
  return rows.length > 0;
}

export async function forgetUpdate(updateId: number): Promise<void> {
  await withActor(SYSTEM, (tx) => tx.delete(telegramUpdates).where(eq(telegramUpdates.updateId, updateId)));
}

/** Telegram повторяет событие не дольше суток: номера старше двух суток больше не нужны (проверка main, Q8). */
export async function cleanupTelegramUpdates(now: Date = new Date()): Promise<number> {
  const before = new Date(now.getTime() - 2 * 86400 * 1000);
  const rows = await withActor(SYSTEM, (tx) =>
    tx.delete(telegramUpdates).where(lt(telegramUpdates.receivedOn, before)).returning({ updateId: telegramUpdates.updateId }),
  );
  return rows.length;
}
