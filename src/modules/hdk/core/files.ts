import 'server-only';
import { and, eq, inArray, lt } from 'drizzle-orm';
import type { SystemActor } from '@/db/with-actor';
import { withActor } from '@/db/with-actor';
import { getStorage, type QuarantineResult, scanQuarantinedImage, writeAudit } from '@/modules/hdc/api';
import { fileQuarantineKey, fileStorageKey, type FileScanStatus } from '../pref';
import { kbArticleFiles } from '../schema';
import { fileByIdTx, type FileRow } from './editor';

// Модуль hdk, слой core: проверка изображения решения (задача kb.scan; план M5, решения 13 и 16). Тот же порядок, что
// у вложений обращений (решение 0027): настоящий тип по первым байтам, затем антивирус по тому же чтению, перенос
// из карантина в files/kb/{article_id}/{file_id} только прочитанной версии. Принимаются только PNG, JPEG и WebP.

async function finish(actor: SystemActor, row: FileRow, result: QuarantineResult): Promise<FileScanStatus> {
  return withActor(actor, async (tx) => {
    const columns =
      result.scanStatus === 'clean' ? { scanStatus: result.scanStatus, storageKey: result.storageKey, ...(result.sha256 ? { sha256: result.sha256 } : {}) } : { scanStatus: result.scanStatus };
    const signature = result.scanStatus === 'infected' ? result.signature : null;
    const updated = await tx
      .update(kbArticleFiles)
      .set(columns)
      .where(and(eq(kbArticleFiles.fileId, row.fileId), eq(kbArticleFiles.scanStatus, 'pending')))
      .returning({ scanStatus: kbArticleFiles.scanStatus });
    if (updated.length === 0) return (await fileByIdTx(tx, row.fileId))?.scanStatus ?? result.scanStatus;
    if (result.scanStatus === 'infected')
      await writeAudit(tx, {
        action: 'solution.file_infected',
        objectType: 'solution_file',
        objectId: row.fileId,
        diff: { articleId: row.articleId, signature },
      });
    return result.scanStatus;
  });
}

/** Проверка изображения решения. Антивирус не ответил: исключение, файл остаётся pending, задача повторится. */
export async function scanFile(actor: SystemActor, fileId: string): Promise<FileScanStatus | null> {
  const row = await withActor(actor, (tx) => fileByIdTx(tx, fileId));
  if (!row) return null;
  if (row.scanStatus !== 'pending') {
    await getStorage().remove(fileQuarantineKey(row.fileId));
    return row.scanStatus;
  }
  // Тип по содержимому, антивирус и перенос делает общая проверка изображений модуля hdc (та же у изображений идей).
  const result = await scanQuarantinedImage({ quarantineKey: fileQuarantineKey(row.fileId), targetKey: fileStorageKey(row.articleId, row.fileId), mime: row.mime, size: row.size });
  return finish(actor, row, result);
}

/** Обход: строки pending старше срока становятся "не принят" (пачкой, занятые другим процессом пропускаются). */
export async function rejectStuckFiles(actor: SystemActor, before: Date, limit: number): Promise<string[]> {
  const rows = await withActor(actor, (tx) =>
    tx
      .update(kbArticleFiles)
      .set({ scanStatus: 'rejected' })
      .where(
        inArray(
          kbArticleFiles.fileId,
          tx
            .select({ fileId: kbArticleFiles.fileId })
            .from(kbArticleFiles)
            .where(and(eq(kbArticleFiles.scanStatus, 'pending'), lt(kbArticleFiles.createdOn, before)))
            .orderBy(kbArticleFiles.createdOn)
            .limit(limit)
            .for('update', { skipLocked: true }),
        ),
      )
      .returning({ fileId: kbArticleFiles.fileId }),
  );
  return rows.map((row) => row.fileId);
}

/** Обход: строки pending, созданные раньше срока. */
export async function pendingFiles(actor: SystemActor, before: Date, limit: number): Promise<{ id: string; createdOn: Date }[]> {
  return withActor(actor, (tx) =>
    tx
      .select({ id: kbArticleFiles.fileId, createdOn: kbArticleFiles.createdOn })
      .from(kbArticleFiles)
      .where(and(eq(kbArticleFiles.scanStatus, 'pending'), lt(kbArticleFiles.createdOn, before)))
      .orderBy(kbArticleFiles.createdOn)
      .limit(limit),
  );
}
