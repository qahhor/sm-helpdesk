import 'server-only';
import type { Tx } from '@/db/client';
import type { SystemActor } from '@/db/with-actor';
import type { DomainEvent } from '@/modules/hdc/api';
import { createRuleRun, handleRuleEventTx, type NoActivityOptions, type RuleRun, runNoActivityTx } from '../core/engine';
import { cleanupRuleRunsTx, inactiveBuiltinCodesTx } from '../core/rules';

// Модуль hdw, слой api: применение правил для фонового процесса (план M8, задача 3). Узкий файл: его берёт
// фоновый процесс, в сборку которого не должны попадать страницы и Next.js. Вызывает только система.

export type { NoActivityOptions, RuleRun } from '../core/engine';
export { setWebhookDeliverer, type WebhookDeliverer } from '../core/actions';
export { RUNS_KEEP_DAYS } from '../pref';

/** Состояние одного запуска разбора событий: счётчики и сотрудники, прочитанные один раз. */
export function newRuleRun(opts: { now?: () => Date } = {}): RuleRun {
  return createRuleRun(opts);
}

/**
 * Обработчик события для processEvents (модуль hdc): правила события применяются в транзакции события. Транзакция
 * должна быть системной: это проверяет блокировка обращения в модуле обращений.
 */
export function handleRuleEvent(tx: Tx, event: DomainEvent, run: RuleRun): Promise<void> {
  return handleRuleEventTx(tx, event, run);
}

/** Событие "нет активности N часов": раз в минуту из задачи automation.process. */
export function runNoActivityRules(actor: SystemActor, opts: NoActivityOptions = {}): Promise<{ checked: number; applied: number; failed: number }> {
  return runNoActivityTx(actor, opts);
}

/**
 * Коды предустановленных правил, уведомление которых сейчас не уходит: правило выключено, негодно или осталось без
 * своего уведомления. Проверка состояния портала (ops.watch) шлёт по ним сигнал дежурным.
 */
export function inactiveBuiltinRules(actor: SystemActor): Promise<string[]> {
  if (actor.type !== 'system') throw new Error('Состояние правил для сигнала читает только система');
  return inactiveBuiltinCodesTx(actor);
}

/** Ночная очистка: срабатывания правил старше 90 суток. */
export function cleanupRuleRuns(actor: SystemActor, now: Date = new Date()): Promise<number> {
  if (actor.type !== 'system') throw new Error('Очистку выполняет только система');
  return cleanupRuleRunsTx(actor, now);
}
