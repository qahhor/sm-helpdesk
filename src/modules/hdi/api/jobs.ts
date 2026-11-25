import 'server-only';
import * as z from 'zod';
import type { SystemActor } from '@/db/with-actor';
import { withActor } from '@/db/with-actor';
import { indexIdeaTexts } from '@/modules/hdk/api/idea-search';
import { scanUpload } from '../core/files';
import { ideaIndexSourceTx } from '../core/index';
import type { IdeaScanStatus } from '../pref';

// Модуль hdi, слой api: задачи фонового процесса (план M7). Узкий файл: его тянет фоновый процесс, страниц и Next.js
// в нём нет. В задаче только идентификаторы, остальное берётся из базы.

const scanJob = z.strictObject({ attachmentId: z.uuid() });

/** ideas.scan: проверка изображения идеи (решение 10). Строки уже нет: null, повтор не нужен. */
export function scanIdeaAttachment(system: SystemActor, data: unknown): Promise<IdeaScanStatus | null> {
  const { attachmentId } = scanJob.parse(data);
  return scanUpload(system, attachmentId);
}

const ideaJob = z.strictObject({ ideaId: z.uuid() });

/**
 * ideas.index: строки индекса похожих идей по видимым клиентам текстам опубликованной идеи (решение 23). Идея не
 * опубликована или уже отклонена и объединена: строки снимаются. Сервис векторов недоступен: строки со словами уже
 * записаны, задача бросает ошибку и повторяется.
 */
export async function runIdeaIndexJob(system: SystemActor, data: unknown): Promise<{ indexed: number; removed: number; embedded: number }> {
  const { ideaId } = ideaJob.parse(data);
  const source = await withActor(system, (tx) => ideaIndexSourceTx(tx, ideaId));
  return indexIdeaTexts(system, { ideaId, moduleId: source.moduleId, texts: source.texts });
}
