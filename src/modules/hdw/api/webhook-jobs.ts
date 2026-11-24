import 'server-only';
import type { Tx } from '@/db/client';
import type { SystemActor } from '@/db/with-actor';
import type { DomainEvent } from '@/modules/hdc/api';
import { cleanupDeliveriesTx, dispatchWebhooksTx, enqueueEventDeliveriesTx, hasDueDeliveriesTx, resealWebhookSecretsTx, type WebhookDispatchOptions, type WebhookDispatchResult } from '../core/deliveries';

// Модуль hdw, слой api: исходящие вебхуки для фонового процесса и команды консоли (план M8, задача 5). Узкий файл:
// его берут фоновый процесс и команда hub, в сборку которых не должны попадать страницы и Next.js. Вызывает только
// система.

export type { WebhookDispatchOptions, WebhookDispatchResult } from '../core/deliveries';
export { wakeWebhooks } from '../core/deliveries';
export { DELIVERIES_KEEP_DAYS, WEBHOOK_MAX_ATTEMPTS, WEBHOOK_RETRY_MINUTES } from '../pref';

function requireSystem(actor: SystemActor): void {
  if (actor.type !== 'system') throw new Error('Вебхуки ведёт только система');
}

/**
 * Обработчик события для processEvents: событие уходит адресам, которые на него подписаны. Работает в транзакции
 * события после правил: доставка фиксируется вместе с отметкой разбора. Возвращает число поставленных доставок.
 */
export function handleWebhookEvent(tx: Tx, event: DomainEvent): Promise<number> {
  return enqueueEventDeliveriesTx(tx, event);
}

/** Отправка очереди доставок: задача webhooks.dispatch раз в минуту и по сигналу. */
export function dispatchWebhooks(actor: SystemActor, opts: WebhookDispatchOptions = {}): Promise<WebhookDispatchResult> {
  requireSystem(actor);
  return dispatchWebhooksTx(actor, opts);
}

/** Есть ли доставки, которые пора отправлять. */
export function hasDueDeliveries(actor: SystemActor, now: Date = new Date()): Promise<boolean> {
  requireSystem(actor);
  return hasDueDeliveriesTx(actor, now);
}

/** Ночная очистка: доставки старше 30 суток. */
export function cleanupWebhookDeliveries(actor: SystemActor, now: Date = new Date()): Promise<number> {
  requireSystem(actor);
  return cleanupDeliveriesTx(actor, now);
}

/** Замена ключа шифрования: секреты вебхуков перешифровываются текущим ключом (команда hub secrets:reseal). */
export function resealWebhookSecrets(actor: SystemActor): Promise<{ resealed: number; failed: string[] }> {
  requireSystem(actor);
  return resealWebhookSecretsTx(actor);
}
