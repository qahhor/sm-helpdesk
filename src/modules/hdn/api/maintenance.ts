import 'server-only';
import type { SystemActor } from '@/db/with-actor';
import { cleanupTelegramUpdates as cleanupCore } from '../core';

// Обслуживание из команды консоли hub (проверка main, Q8). Только актор system.

export function cleanupTelegramUpdates(actor: SystemActor, now?: Date): Promise<number> {
  if (actor.type !== 'system') throw new Error('Очистку выполняет только система');
  return cleanupCore(now);
}
