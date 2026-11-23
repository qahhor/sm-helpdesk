import 'server-only';
import type { SystemActor } from '@/db/with-actor';
import { cleanupInboundTx } from '../core/inbound';
import { cleanupOutboxTx } from '../core/outbox';
import { cleanupTelegramUpdates as cleanupCore } from '../core/telegram-updates';

// Обслуживание из команды консоли hub (проверка main, Q8). Только актор system.

export function cleanupTelegramUpdates(actor: SystemActor, now?: Date): Promise<number> {
  if (actor.type !== 'system') throw new Error('Очистку выполняет только система');
  return cleanupCore(now);
}

/** Отправленные строки очереди исходящих старше 30 суток. */
export function cleanupOutbox(actor: SystemActor, now: Date = new Date()): Promise<number> {
  if (actor.type !== 'system') throw new Error('Очистку выполняет только система');
  return cleanupOutboxTx(actor, now);
}

/** Разобранные входящие письма старше 90 суток. */
export function cleanupInbound(actor: SystemActor, now: Date = new Date()): Promise<number> {
  if (actor.type !== 'system') throw new Error('Очистку выполняет только система');
  return cleanupInboundTx(actor, now);
}
