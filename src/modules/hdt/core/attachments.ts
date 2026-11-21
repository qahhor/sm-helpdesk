import 'server-only';
import { and, eq, sql } from 'drizzle-orm';
import { type ClientActor, type SystemActor, withActor } from '@/db/with-actor';
import type { ScanStatus } from '../pref';
import { attachments } from '../schema';

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
