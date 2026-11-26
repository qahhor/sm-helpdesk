import 'server-only';
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import type { Tx } from '@/db/client';
import type { ClientActor, SystemActor } from '@/db/with-actor';
import { withActor } from '@/db/with-actor';
import { getStorage, type QuarantineResult, scanQuarantinedImage, writeAudit } from '@/modules/hdc/api';
import { ideaQuarantineKey, type IdeaScanStatus, ideaStorageKey } from '../pref';
import { ideaAttachments, ideas } from '../schema';

// Модуль hdi, слой core: изображения идеи (план M7, решение 10). Та же загрузка, что у вложений обращений и
// изображений решений (решения 0027, 0048): строка в карантине, подписанная ссылка, "загрузка завершена" ставит
// задачу ideas.scan, проверка типа по содержимому и антивирус общей функцией модуля hdc, перенос в
// files/ideas/{org}/{id}. До проверки чужим файл не виден (политика), автору видно только состояние.

export type IdeaUpload = { attachmentId: string; orgId: string; ideaId: string | null; uploaderId: string; mime: string; size: number; scanStatus: IdeaScanStatus };

const uploadColumns = {
  attachmentId: ideaAttachments.attachmentId,
  orgId: ideaAttachments.orgId,
  ideaId: ideaAttachments.ideaId,
  uploaderId: ideaAttachments.uploaderId,
  mime: ideaAttachments.mime,
  size: ideaAttachments.size,
  scanStatus: ideaAttachments.scanStatus,
};

/** Строка загрузки в карантине от имени клиента. */
export async function createUploadTx(tx: Tx, actor: ClientActor, upload: { fileName: string; mime: string; size: number }): Promise<string> {
  // Идентификатор задаёт портал: ключ карантина строится из него сразу.
  const attachmentId = randomUUID();
  await tx
    .insert(ideaAttachments)
    .values({ orgId: actor.orgId, attachmentId, uploaderId: actor.userId, storageKey: ideaQuarantineKey(attachmentId), fileName: upload.fileName, mime: upload.mime, size: upload.size });
  return attachmentId;
}

/** Своя загрузка (клиент видит свои в любом состоянии). */
export async function ownUploadTx(tx: Tx, actor: ClientActor, attachmentId: string): Promise<IdeaUpload | null> {
  const [row] = await tx
    .select(uploadColumns)
    .from(ideaAttachments)
    .where(and(eq(ideaAttachments.attachmentId, attachmentId), eq(ideaAttachments.uploaderId, actor.userId)))
    .limit(1);
  return row ?? null;
}

async function finish(actor: SystemActor, row: IdeaUpload, result: QuarantineResult): Promise<IdeaScanStatus> {
  return withActor(actor, async (tx) => {
    const columns =
      result.scanStatus === 'clean' ? { scanStatus: result.scanStatus, storageKey: result.storageKey, ...(result.sha256 ? { sha256: result.sha256 } : {}) } : { scanStatus: result.scanStatus };
    const updated = await tx
      .update(ideaAttachments)
      .set(columns)
      .where(and(eq(ideaAttachments.attachmentId, row.attachmentId), eq(ideaAttachments.scanStatus, 'pending')))
      .returning({ scanStatus: ideaAttachments.scanStatus });
    if (updated.length === 0) {
      const [current] = await tx.select({ scanStatus: ideaAttachments.scanStatus }).from(ideaAttachments).where(eq(ideaAttachments.attachmentId, row.attachmentId)).limit(1);
      return current?.scanStatus ?? result.scanStatus;
    }
    if (result.scanStatus === 'infected')
      await writeAudit(tx, { action: 'idea.file_infected', objectType: 'idea_attachment', objectId: row.attachmentId, orgId: row.orgId, diff: { signature: result.signature } });
    return result.scanStatus;
  });
}

/** Задача ideas.scan. Строки нет: null. Антивирус не ответил: исключение, файл остаётся pending, задача повторится. */
export async function scanUpload(actor: SystemActor, attachmentId: string): Promise<IdeaScanStatus | null> {
  const [row] = await withActor(actor, (tx) => tx.select(uploadColumns).from(ideaAttachments).where(eq(ideaAttachments.attachmentId, attachmentId)).limit(1));
  if (!row) return null;
  if (row.scanStatus !== 'pending') {
    await getStorage().remove(ideaQuarantineKey(row.attachmentId));
    return row.scanStatus;
  }
  const result = await scanQuarantinedImage({ quarantineKey: ideaQuarantineKey(row.attachmentId), targetKey: ideaStorageKey(row.orgId, row.attachmentId), mime: row.mime, size: row.size });
  return finish(actor, row, result);
}

/** Загрузка не дошла или размер другой: rejected сразу (строку меняет только система). */
export async function rejectUpload(actor: SystemActor, attachmentId: string): Promise<void> {
  await withActor(actor, (tx) =>
    tx.update(ideaAttachments).set({ scanStatus: 'rejected' }).where(and(eq(ideaAttachments.attachmentId, attachmentId), eq(ideaAttachments.scanStatus, 'pending'))),
  );
}

/** Файл видимой актору идеи для показа: идея по номеру, вложение этой идеи. Невидимые: null. */
export async function ideaFileTx(tx: Tx, number: number, attachmentId: string): Promise<{ storageKey: string; mime: string; size: number; fileName: string; scanStatus: IdeaScanStatus } | null> {
  const [idea] = await tx.select({ ideaId: ideas.ideaId }).from(ideas).where(eq(ideas.number, number)).limit(1);
  if (!idea) return null;
  const [file] = await tx
    .select({ storageKey: ideaAttachments.storageKey, mime: ideaAttachments.mime, size: ideaAttachments.size, fileName: ideaAttachments.fileName, scanStatus: ideaAttachments.scanStatus })
    .from(ideaAttachments)
    .where(and(eq(ideaAttachments.attachmentId, attachmentId), eq(ideaAttachments.ideaId, idea.ideaId)))
    .limit(1);
  return file ?? null;
}
