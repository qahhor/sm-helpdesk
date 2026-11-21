import 'server-only';
import { createHash } from 'node:crypto';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { type ClientActor, type SystemActor, withActor } from '@/db/with-actor';
import { enqueue, getScanner, getStorage, SNIFF_BYTES, sniffFileType, writeAudit } from '@/modules/hdc/api';
import { HdtError } from '../error';
import { ENCRYPTED_OFFICE_SIGNATURE, type ScanStatus, SWEEP_BATCH } from '../pref';
import { attachments } from '../schema';
import { fileKey, isEncryptedOffice, quarantineKey, rejectReasonOf, typeMatches } from '../util';

// Модуль hdt, слой core: загрузки в карантин (раздел 11.11, решение 0027). Строка создаётся до загрузки,
// ключ хранилища строится из её идентификатора. Организация и загрузивший берутся из актора.

export type NewUpload = { fileName: string; mime: string; size: number };
/** Своя загрузка. Ключа хранилища нет намеренно: до проверки файл лежит в карантине, ключ берётся из идентификатора. */
export type UploadRecord = { attachmentId: string; size: number; scanStatus: ScanStatus };

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
      .select({ attachmentId: attachments.attachmentId, size: attachments.size, scanStatus: attachments.scanStatus })
      .from(attachments)
      .where(and(eq(attachments.attachmentId, attachmentId), eq(attachments.uploaderId, actor.userId)));
    return row ?? null;
  });
}

/**
 * Вложение, которое актор может скачать: только проверенное чистое, не внутреннее и уже перенесённое из карантина.
 * Чужое, несуществующее и непроверенное неразличимы: null (строка 15.2). Видимость обращения решают политики RLS.
 */
export async function findDownloadable(
  actor: ClientActor,
  attachmentId: string,
): Promise<{ storageKey: string; fileName: string; mime: string } | null> {
  return withActor(actor, async (tx) => {
    const [row] = await tx
      .select({ storageKey: attachments.storageKey, fileName: attachments.fileName, mime: attachments.mime })
      .from(attachments)
      .where(
        and(
          eq(attachments.attachmentId, attachmentId),
          eq(attachments.scanStatus, 'clean'),
          eq(attachments.isInternal, false),
          sql`${attachments.storageKey} like 'files/%'`,
        ),
      );
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
  scanSignature?: string | null;
  sha256?: string;
};

/**
 * Первые bytes байт потока и поток всего файла с теми же байтами в начале: тип определяется и антивирус читает
 * одно и то же чтение объекта. Два отдельных чтения дали бы загрузившему окно подменить файл между ними.
 */
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
    // В карантине не остаётся ничего, кроме непроверенного: удаление могло не пройти в прошлый раз, а ссылка
    // на загрузку живёт 300 секунд, и по ней могли положить файл повторно. Чистый файл лежит в files/, его не трогаем.
    await storage.remove(quarantine);
    return row.scanStatus;
  }
  if (!(await storage.head(quarantine))) {
    // Обрыв после переноса: в files/ файл кладёт только эта функция после чистой проверки.
    if (await storage.head(target)) return finish(row, { scanStatus: 'clean', storageKey: target });
    return finish(row, { scanStatus: 'rejected' });
  }

  // Одно чтение объекта: по его началу тип, по нему же антивирус и хеш, его метка (ETag) при переносе.
  const { body, etag } = await storage.stream(quarantine);
  const { head, whole } = await splitHead(body, SNIFF_BYTES);
  const detected = sniffFileType(head);
  if (!typeMatches(row.mime, detected)) {
    await whole.cancel().catch(() => {});
    // Документ с паролем называется причиной: клиенту понятно, что приложить его нужно без пароля.
    const scanSignature = isEncryptedOffice(row.mime, detected) ? ENCRYPTED_OFFICE_SIGNATURE : null;
    const status = await finish(row, { scanStatus: 'rejected', detectedType: detected, scanSignature });
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
  if (!verdict.clean) {
    // Зашифрованный файл и файл сверх пределов проверки антивирус не прочитал: это отказ, а не заражение.
    const signature = verdict.signature ?? 'unknown';
    const scanStatus = rejectReasonOf(signature) ? 'rejected' : 'infected';
    const status = await finish(row, { scanStatus, detectedType: detected, scanSignature: signature });
    await storage.remove(quarantine);
    return status;
  }
  // Антивирус прочитал не тот размер, что заявлен и проверен при загрузке: файл заменили, он не принимается.
  if (scanned !== row.size) {
    const status = await finish(row, { scanStatus: 'rejected', detectedType: detected });
    await storage.remove(quarantine);
    return status;
  }
  // Переносится только прочитанная версия: подменённый после чтения файл не копируется, задача повторится.
  await storage.move(quarantine, target, { contentType: row.mime, ifMatch: etag });
  return finish(row, { scanStatus: 'clean', storageKey: target, detectedType: detected, sha256: hash.digest('hex') });
}

// --- Обход загрузок (расписание attachment.sweep раз в минуту, решение 0028) ---

const SWEEP_ACTOR: SystemActor = { type: 'system', job: 'attachment.sweep' };

/**
 * Файлы pending старше двух минут снова ставятся на проверку: постановка после "загрузка завершена" могла
 * не пройти. Пока файла в карантине нет, браузер, возможно, ещё загружает его: такой ставится только через час,
 * и проверка отклонит его. Файл pending старше суток не принимается (scan_failed). Неприкреплённые загрузки
 * старше суток удаляются вместе с файлами.
 */
export async function sweepAttachments(): Promise<{ requeued: number; removed: number; failed: number }> {
  const storage = getStorage();
  // Проверка, которая не прошла за сутки (антивирус не отвечает, файл не успевает за тайм-аут), заканчивается:
  // файл не принимается, иначе он вечно "проверяется", а задача каждую минуту гоняет его через антивирус.
  // Пачкой: после долгого простоя антивируса зависших файлов много, одна транзакция на все держала бы блокировки.
  const stuck = await withActor(SWEEP_ACTOR, (tx) =>
    tx
      .update(attachments)
      .set({ scanStatus: 'rejected', scanSignature: 'scan_failed' })
      .where(
        inArray(
          attachments.attachmentId,
          tx
            .select({ attachmentId: attachments.attachmentId })
            .from(attachments)
            .where(and(eq(attachments.scanStatus, 'pending'), sql`${attachments.createdOn} < now() - interval '1 day'`))
            .orderBy(attachments.createdOn)
            .limit(SWEEP_BATCH)
            .for('update', { skipLocked: true }),
        ),
      )
      .returning({ attachmentId: attachments.attachmentId }),
  );
  for (const row of stuck) {
    console.error(`Проверка файла ${row.attachmentId} не прошла за сутки: файл не принят (scan_failed)`);
    await storage.remove(quarantineKey(row.attachmentId)).catch(() => {});
  }
  const pending = await withActor(SWEEP_ACTOR, (tx) =>
    tx.execute<{ attachment_id: string; abandoned: boolean }>(sql`
      select attachment_id, created_on < now() - interval '1 hour' as abandoned
        from hdt_attachments
       where scan_status = 'pending' and created_on < now() - interval '2 minutes'
       order by created_on
       limit ${SWEEP_BATCH}`),
  );
  let requeued = 0;
  for (const row of pending.rows) {
    if (!row.abandoned && !(await storage.head(quarantineKey(row.attachment_id)))) continue;
    await enqueue('attachment.scan', { attachmentId: row.attachment_id });
    requeued += 1;
  }

  const stale = await withActor(SWEEP_ACTOR, (tx) =>
    tx
      .select({ attachmentId: attachments.attachmentId, orgId: attachments.orgId })
      .from(attachments)
      .where(and(isNull(attachments.ticketId), sql`${attachments.createdOn} < now() - interval '1 day'`))
      .orderBy(attachments.createdOn)
      .limit(SWEEP_BATCH),
  );
  let removed = 0;
  for (const row of stale) {
    // Сначала строка: если загрузку успели прикрепить, она не удаляется и файл остаётся.
    const deleted = await withActor(SWEEP_ACTOR, (tx) =>
      tx
        .delete(attachments)
        .where(and(eq(attachments.attachmentId, row.attachmentId), isNull(attachments.ticketId)))
        .returning({ attachmentId: attachments.attachmentId }),
    );
    if (deleted.length === 0) continue;
    removed += 1;
    try {
      await storage.remove(quarantineKey(row.attachmentId));
      await storage.remove(fileKey(row.orgId, row.attachmentId));
    } catch (error) {
      // Строки уже нет, файл без строки никому не выдаётся. Остаток в хранилище виден по журналу.
      console.error(`Файл загрузки ${row.attachmentId} не удалён из хранилища: ${error instanceof Error ? error.message : 'ошибка'}`);
    }
  }
  return { requeued, removed, failed: stuck.length };
}
