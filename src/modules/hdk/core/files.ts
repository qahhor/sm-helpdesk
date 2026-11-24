import 'server-only';
import { createHash } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import type { SystemActor } from '@/db/with-actor';
import { withActor } from '@/db/with-actor';
import { getScanner, getStorage, sniffFileType, SNIFF_BYTES, writeAudit } from '@/modules/hdc/api';
import { fileQuarantineKey, fileStorageKey, type FileScanStatus } from '../pref';
import { kbArticleFiles } from '../schema';
import { fileByIdTx, type FileRow } from './editor';

// Модуль hdk, слой core: проверка изображения решения (задача kb.scan; план M5, решения 13 и 16). Тот же порядок, что
// у вложений обращений (решение 0027): настоящий тип по первым байтам, затем антивирус по тому же чтению, перенос
// из карантина в files/kb/{article_id}/{file_id} только прочитанной версии. Принимаются только PNG, JPEG и WebP.

const SNIFFED_MIME: Record<string, string> = {
  png: 'image/png',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
};

/** Первые bytes байт потока и поток всего файла с теми же байтами в начале: одно чтение объекта. */
async function splitHead(stream: ReadableStream<Uint8Array>, bytes: number): Promise<{ head: Uint8Array; whole: ReadableStream<Uint8Array> }> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let read = 0;
  let finished = false;
  while (read < bytes) {
    const { done, value } = await reader.read();
    if (done) {
      finished = true;
      break;
    }
    chunks.push(value);
    read += value.byteLength;
  }
  const buffered = new Uint8Array(read);
  let offset = 0;
  for (const chunk of chunks) {
    buffered.set(chunk, offset);
    offset += chunk.byteLength;
  }
  let sentHead = false;
  const whole = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (!sentHead) {
        sentHead = true;
        if (buffered.byteLength > 0) return controller.enqueue(buffered);
      }
      if (finished) return controller.close();
      const { done, value } = await reader.read();
      if (done) controller.close();
      else controller.enqueue(value);
    },
    cancel: (reason) => reader.cancel(reason),
  });
  return { head: buffered.subarray(0, bytes), whole };
}

type Result = {
  scanStatus: Exclude<FileScanStatus, 'pending'>;
  storageKey?: string;
  sha256?: string;
  signature?: string;
};

async function finish(actor: SystemActor, row: FileRow, result: Result): Promise<FileScanStatus> {
  return withActor(actor, async (tx) => {
    const { signature, ...columns } = result;
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
        diff: { articleId: row.articleId, signature: signature ?? null },
      });
    return result.scanStatus;
  });
}

/** Проверка изображения решения. Антивирус не ответил: исключение, файл остаётся pending, задача повторится. */
export async function scanFile(actor: SystemActor, fileId: string): Promise<FileScanStatus | null> {
  const row = await withActor(actor, (tx) => fileByIdTx(tx, fileId));
  if (!row) return null;
  const storage = getStorage();
  const quarantine = fileQuarantineKey(row.fileId);
  const target = fileStorageKey(row.articleId, row.fileId);
  if (row.scanStatus !== 'pending') {
    await storage.remove(quarantine);
    return row.scanStatus;
  }
  if (!(await storage.head(quarantine))) {
    if (await storage.head(target)) return finish(actor, row, { scanStatus: 'clean', storageKey: target });
    return finish(actor, row, { scanStatus: 'rejected' });
  }
  const { body, etag } = await storage.stream(quarantine);
  const { head, whole } = await splitHead(body, SNIFF_BYTES);
  if (SNIFFED_MIME[sniffFileType(head)] !== row.mime) {
    await whole.cancel().catch(() => {});
    const status = await finish(actor, row, { scanStatus: 'rejected' });
    await storage.remove(quarantine);
    return status;
  }
  const hash = createHash('sha256');
  let scanned = 0;
  const hashing = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      hash.update(chunk);
      scanned += chunk.byteLength;
      controller.enqueue(chunk);
    },
  });
  const verdict = await getScanner().scan(whole.pipeThrough(hashing));
  if (!verdict.clean || scanned !== row.size) {
    const status = await finish(actor, row, verdict.clean ? { scanStatus: 'rejected' } : { scanStatus: 'infected', signature: verdict.signature ?? 'unknown' });
    await storage.remove(quarantine);
    return status;
  }
  await storage.move(quarantine, target, {
    contentType: row.mime,
    ifMatch: etag,
  });
  return finish(actor, row, {
    scanStatus: 'clean',
    storageKey: target,
    sha256: hash.digest('hex'),
  });
}
