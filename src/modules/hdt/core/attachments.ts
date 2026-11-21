import 'server-only';
import { createHash } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { type ClientActor, type SystemActor, withActor } from '@/db/with-actor';
import { getScanner, getStorage, SNIFF_BYTES, sniffFileType, writeAudit } from '@/modules/hdc/api';
import { HdtError } from '../error';
import { DETECTED_BY_MIME, type ScanStatus } from '../pref';
import { attachments } from '../schema';
import { fileKey, quarantineKey } from '../util';

// Модуль hdt, слой core: загрузки в карантин (раздел 11.11, решение 0027). Строка создаётся до загрузки,
// ключ хранилища строится из её идентификатора. Организация и загрузивший берутся из актора.

export type NewUpload = { fileName: string; mime: string; size: number };
export type UploadRecord = { attachmentId: string; storageKey: string; size: number; scanStatus: ScanStatus };

/** Строка неприкреплённой загрузки со статусом pending и ключом quarantine/{attachment_id}. */
export async function createUploadTx(actor: ClientActor, upload: NewUpload): Promise<string> {
  return withActor(actor, async (tx) => {
    const result = await tx.execute<{ attachment_id: string }>(sql`
      insert into hdt_attachments (attachment_id, org_id, uploader_id, storage_key, file_name, mime, size, scan_status)
      select id, ${actor.orgId}::uuid, ${actor.userId}::uuid, 'quarantine/' || id, ${upload.fileName}, ${upload.mime}, ${upload.size}, 'pending'
        from (select uuidv7() as id) as generated
      returning attachment_id`);
    const id = result.rows[0]?.attachment_id;
    if (!id) throw new Error('hdt: загрузка не создана');
    return id;
  });
}

/** Своя загрузка актора или null: чужую политики RLS и условие на загрузившего не отдают. */
export async function findOwnUpload(actor: ClientActor, attachmentId: string): Promise<UploadRecord | null> {
  return withActor(actor, async (tx) => {
    const [row] = await tx
      .select({ attachmentId: attachments.attachmentId, storageKey: attachments.storageKey, size: attachments.size, scanStatus: attachments.scanStatus })
      .from(attachments)
      .where(and(eq(attachments.attachmentId, attachmentId), eq(attachments.uploaderId, actor.userId)));
    return row ?? null;
  });
}

/**
 * Отклоняет загрузку, файл которой не пришёл или не совпал по размеру. Состояние проверки клиент менять не может
 * (триггер t_hdt_attachments_client_guard), поэтому меняет фоновая роль, и только строку этого загрузившего в pending.
 */
export async function rejectUploadTx(actor: ClientActor, attachmentId: string): Promise<void> {
  const system: SystemActor = { type: 'system', job: 'uploads.complete', ip: actor.ip ?? null };
  await withActor(system, (tx) =>
    tx
      .update(attachments)
      .set({ scanStatus: 'rejected' })
      .where(and(eq(attachments.attachmentId, attachmentId), eq(attachments.uploaderId, actor.userId), eq(attachments.scanStatus, 'pending'))),
  );
}

// --- Проверка вложения (задача attachment.scan) ---

const SCAN_ACTOR: SystemActor = { type: 'system', job: 'attachment.scan' };

type ScanRow = { attachmentId: string; orgId: string; mime: string; size: number; scanStatus: ScanStatus };
type ScanResult = {
  scanStatus: Exclude<ScanStatus, 'pending'>;
  storageKey?: string;
  detectedType?: string;
  scanSignature?: string;
  sha256?: string;
};

/** Первые bytes байт потока, остальное не читается. */
async function readHead(stream: ReadableStream<Uint8Array>, bytes: number): Promise<Uint8Array> {
  const reader = stream.getReader();
  const head = new Uint8Array(bytes);
  let read = 0;
  while (read < bytes) {
    const { done, value } = await reader.read();
    if (done) break;
    const take = value.subarray(0, bytes - read);
    head.set(take, read);
    read += take.byteLength;
  }
  await reader.cancel().catch(() => {});
  return head.subarray(0, read);
}

/** Итог проверки в строку, только если она ещё pending. Заражённый файл пишется в журнал аудита той же транзакцией. */
async function finish(row: ScanRow, result: ScanResult): Promise<ScanStatus> {
  return withActor(SCAN_ACTOR, async (tx) => {
    const updated = await tx
      .update(attachments)
      .set(result)
      .where(and(eq(attachments.attachmentId, row.attachmentId), eq(attachments.scanStatus, 'pending')))
      .returning({ scanStatus: attachments.scanStatus });
    if (updated.length === 0) {
      // Другая задача успела раньше: её итог и есть ответ.
      const [current] = await tx.select({ scanStatus: attachments.scanStatus }).from(attachments).where(eq(attachments.attachmentId, row.attachmentId));
      return current?.scanStatus ?? result.scanStatus;
    }
    if (result.scanStatus === 'infected')
      await writeAudit(tx, {
        action: 'attachment.infected',
        objectType: 'attachment',
        objectId: row.attachmentId,
        orgId: row.orgId,
        diff: { signature: result.scanSignature ?? null },
      });
    return result.scanStatus;
  });
}

/**
 * Проверка загруженного файла (раздел 11.11, угроза T6): настоящий тип по первым 4 КБ сверяется с заявленным,
 * затем антивирус. Чистый файл переносится из карантина в files/{org_id}/, заражённый и неверного типа
 * удаляется. Антивирус не ответил: исключение, файл остаётся pending, задача повторяется.
 * Повторный вызов для проверенного файла ничего не меняет.
 */
export async function scanAttachment(attachmentId: string): Promise<ScanStatus> {
  const [row] = await withActor(SCAN_ACTOR, (tx) =>
    tx
      .select({ attachmentId: attachments.attachmentId, orgId: attachments.orgId, mime: attachments.mime, size: attachments.size, scanStatus: attachments.scanStatus })
      .from(attachments)
      .where(eq(attachments.attachmentId, attachmentId)),
  );
  if (!row) throw new HdtError('not_found');
  const storage = getStorage();
  const quarantine = quarantineKey(row.attachmentId);
  const target = fileKey(row.orgId, row.attachmentId);
  if (row.scanStatus !== 'pending') {
    // Удаление могло не пройти в прошлый раз: в карантине не остаётся ничего, кроме непроверенного.
    if (row.scanStatus !== 'clean') await storage.remove(quarantine);
    return row.scanStatus;
  }
  if (!(await storage.head(quarantine))) {
    // Обрыв после переноса: в files/ файл кладёт только эта функция после чистой проверки.
    if (await storage.head(target)) return finish(row, { scanStatus: 'clean', storageKey: target });
    return finish(row, { scanStatus: 'rejected' });
  }

  const detected = sniffFileType(await readHead(await storage.stream(quarantine), SNIFF_BYTES));
  if (DETECTED_BY_MIME[row.mime] !== detected) {
    const status = await finish(row, { scanStatus: 'rejected', detectedType: detected });
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
  const verdict = await getScanner().scan((await storage.stream(quarantine)).pipeThrough(hashing));
  if (!verdict.clean) {
    const status = await finish(row, { scanStatus: 'infected', detectedType: detected, scanSignature: verdict.signature ?? 'unknown' });
    await storage.remove(quarantine);
    return status;
  }
  // Чистым считается только файл, прочитанный антивирусом целиком.
  if (scanned !== row.size) throw new Error('hdt: антивирус прочитал файл не целиком');
  await storage.move(quarantine, target);
  return finish(row, { scanStatus: 'clean', storageKey: target, detectedType: detected, sha256: hash.digest('hex') });
}
