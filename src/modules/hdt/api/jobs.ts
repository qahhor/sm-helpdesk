import 'server-only';
import type { SystemActor } from '@/db/with-actor';
import { scanAttachment as scanCore, sweepAttachments as sweepCore } from '../core/attachments';
import { attachmentIdInput, parseInput } from '../input';
import type { ScanStatus } from '../pref';

export { isHdtError } from '../error';

// Задачи фонового процесса над вложениями (решение 0028). Вызывает только система. Фоновый процесс берёт
// этот файл слоя api напрямую, а не общий api.ts: тот тянет за собой страницы входа и Next.js.

function assertSystem(actor: SystemActor): void {
  if (actor.type !== 'system') throw new Error('Задачи вложений выполняет только система');
}

/** Проверка загруженного файла (задача attachment.scan). */
export function scanAttachment(actor: SystemActor, attachmentId: unknown): Promise<ScanStatus> {
  assertSystem(actor);
  return scanCore(parseInput(attachmentIdInput, attachmentId));
}

/** Обход зависших и брошенных загрузок (расписание attachment.sweep). */
export function sweepAttachments(actor: SystemActor): Promise<{ requeued: number; removed: number }> {
  assertSystem(actor);
  return sweepCore();
}
