import 'server-only';
import * as z from 'zod';
import type { SystemActor } from '@/db/with-actor';
import { scanUpload } from '../core/files';
import type { IdeaScanStatus } from '../pref';

// Модуль hdi, слой api: задачи фонового процесса (план M7). Узкий файл: его тянет фоновый процесс, страниц и Next.js
// в нём нет. В задаче только идентификаторы, остальное берётся из базы.

const scanJob = z.strictObject({ attachmentId: z.uuid() });

/** ideas.scan: проверка изображения идеи (решение 10). Строки уже нет: null, повтор не нужен. */
export function scanIdeaAttachment(system: SystemActor, data: unknown): Promise<IdeaScanStatus | null> {
  const { attachmentId } = scanJob.parse(data);
  return scanUpload(system, attachmentId);
}

