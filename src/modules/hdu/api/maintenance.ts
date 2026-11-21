import 'server-only';
import type { SystemActor } from '@/db/with-actor';
import { cleanupAuthRows as cleanupCore } from '../core/maintenance';

// Обслуживание из команды консоли hub (проверка main, Q8). Только актор system.

export function cleanupAuthRows(actor: SystemActor, now?: Date): Promise<{ sessions: number; verifications: number; links: number }> {
  if (actor.type !== 'system') throw new Error('Очистку выполняет только система');
  return cleanupCore(now);
}
