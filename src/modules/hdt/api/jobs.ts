import 'server-only';
import { type SystemActor, withActor } from '@/db/with-actor';
import { infectedSinceTx, scanAttachment as scanCore, sweepAttachments as sweepCore } from '../core/attachments';
import { type MinuteResult, ticketsMinuteTx } from '../core/housekeeping';
import { needsSlaRefreshTx, refreshSla, type SlaState } from '../core/sla';
import { attachmentIdInput, parseInput } from '../input';
import { type ScanStatus, SWEEP_BATCH } from '../pref';
import { wakeOutbox } from '@/modules/hdn/api/outbox';
import { finishGuestMerge, pendingGuestMerges } from '@/modules/hdu/api/guests';
import { moveGuestTx } from '../core/unidentified';

export { isHdtError } from '../error';

// Задачи фонового процесса над вложениями (решение 0028) и пересчёт сроков обращения системой (решение 0032). Вызывает только система. Фоновый процесс берёт
// этот файл слоя api напрямую, а не общий api.ts: тот тянет за собой страницы входа и Next.js.

function assertSystem(actor: SystemActor): void {
  if (actor.type !== 'system') throw new Error('Задачи фонового процесса выполняет только система');
}

/** Проверка загруженного файла (задача attachment.scan). */
export function scanAttachment(actor: SystemActor, attachmentId: unknown): Promise<ScanStatus> {
  assertSystem(actor);
  return scanCore(parseInput(attachmentIdInput, attachmentId));
}

/** Обход зависших и брошенных загрузок (расписание attachment.sweep). */
export function sweepAttachments(actor: SystemActor): Promise<{ requeued: number; removed: number; failed: number }> {
  assertSystem(actor);
  return sweepCore();
}

// --- Сроки обращения (план M3, задача 3) ---

/** Пересчёт сроков обращения системой: после действия клиента и досчётом задачи раз в минуту. */
export function refreshTicketSla(actor: SystemActor, ticketId: string, now: Date = new Date()): Promise<SlaState | null> {
  assertSystem(actor);
  return withActor(actor, (tx) => refreshSla(tx, ticketId, now));
}

/** Обращения, где пересчёт не прошёл (решение 2 плана M3). */
export function needsSlaRefresh(actor: SystemActor, limit: number = SWEEP_BATCH): Promise<string[]> {
  assertSystem(actor);
  return withActor(actor, (tx) => needsSlaRefreshTx(tx, limit));
}

const SLA_ACTOR: SystemActor = { type: 'system', job: 'sla.after_client' };

/**
 * Сроки после фиксации действия клиента: колонки сроков клиент менять не может (миграция 0018), поэтому их
 * пересчитывает система. Сбой не превращает действие клиента в ошибку: его досчитает задача раз в минуту.
 */
export async function refreshSlaAfterClient(ticketId: string): Promise<void> {
  try {
    await refreshTicketSla(SLA_ACTOR, ticketId);
  } catch (error) {
    console.error(`Сроки обращения ${ticketId} не пересчитаны после действия клиента: ${error instanceof Error ? error.message : 'ошибка'}`);
  }
}

// --- Задача раз в минуту (план M3, задача 13) ---

export type { MinuteResult } from '../core/housekeeping';

/** Нарушения сроков, отложенные, автозакрытие, досчёт сроков, присутствие (расписание tickets.minute). */
export async function ticketsMinute(actor: SystemActor, now: Date = new Date()): Promise<MinuteResult> {
  assertSystem(actor);
  const result = await ticketsMinuteTx(actor, now);
  result.guestsMerged = await applyGuestMerges(actor);
  // Письма автозакрытия, напоминаний, нарушений и праздников уже в очереди: отправка будится после фиксации.
  await wakeOutbox();
  return result;
}

// --- Переход гостя к пользователю (план M4, задача 11, решение 13) ---

/** Слияний за один шаг задачи. */
const MERGE_BATCH = 50;

/**
 * Применяет ждущие слияния: обращения, сообщения, вложения и подписки гостя переходят пользователю, гостевые членства
 * становятся passive. Сбой одного слияния не останавливает остальные: оно повторится следующим шагом.
 */
export async function applyGuestMerges(actor: SystemActor): Promise<number> {
  assertSystem(actor);
  let applied = 0;
  for (const merge of await pendingGuestMerges(MERGE_BATCH)) {
    try {
      await moveGuestTx(actor, merge.guestUserId, merge.userId);
      await finishGuestMerge(merge.mergeId, merge.guestUserId);
      applied++;
    } catch (error) {
      console.error(`Слияние гостя ${merge.mergeId} не применено: ${error instanceof Error ? error.message : 'ошибка'}`);
    }
  }
  return applied;
}

/** Заражённые файлы, найденные с этого времени: для сигнала дежурным (ТЗ 13.8). */
export async function infectedSince(actor: SystemActor, since: Date): Promise<number> {
  return infectedSinceTx(actor, since);
}
