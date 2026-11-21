import 'server-only';
import { getStorage, problemResponse } from '@/modules/hdc/api';
import { type ClientContext, currentClient, currentStaff, type StaffContext } from '@/modules/hdu/api';
import { findDownloadable } from '../core/attachments';
import { findStaffDownloadableTx } from '../core/agent-ticket';
import { attachmentIdInput } from '../input';
import { INLINE_IMAGE_TYPES } from '../pref';

// Выдача вложений (FR-TK-13, раздел 14.3): портал файл не отдаёт сам, а перенаправляет на ссылку хранилища
// на 60 секунд. Показ на странице (inline) только у растровых картинок, всё остальное скачивается.

export const DOWNLOAD_LINK_TTL_SEC = 60;

/** Имя файла без пути: последний отрезок после / или \. Пустое имя заменяется словом file. */
const baseName = (name: string): string => name.split(/[\\/]/).pop()?.trim() || 'file';

/** Ссылка на скачивание на 60 секунд или null: чужое, несуществующее, непроверенное и внутреннее неразличимы. */
export async function attachmentRedirect(ctx: ClientContext, id: unknown, opts: { inline: boolean }): Promise<string | null> {
  const parsed = attachmentIdInput.safeParse(id);
  if (!parsed.success) return null;
  const row = await findDownloadable(ctx.actor, parsed.data);
  if (!row) return null;
  const inline = opts.inline && INLINE_IMAGE_TYPES.includes(row.mime);
  return getStorage().presignDownload(row.storageKey, { filename: baseName(row.fileName), contentType: row.mime, ttlSeconds: DOWNLOAD_LINK_TTL_SEC, inline });
}

/** Ответ обработчика: без сессии клиента 401, нет вложения 404, иначе 303 на ссылку без кеширования. */
export async function attachmentResponse(ctx: ClientContext | null, id: unknown, inline: boolean): Promise<Response> {
  if (!ctx) return problemResponse(401, 'unauthenticated');
  const url = await attachmentRedirect(ctx, id, { inline });
  if (!url) return problemResponse(404, 'not_found');
  return new Response(null, { status: 303, headers: { Location: url, 'Cache-Control': 'private, no-store' } });
}

/** Типы, которые сотрудник открывает в окне просмотра (UX-A-14, решение 16 плана M3): картинки и PDF. */
const STAFF_INLINE_TYPES: readonly string[] = [...INLINE_IMAGE_TYPES, 'application/pdf'];

/** Ссылка на файл для сотрудника: чистый файл любого обращения, в том числе заметки. Иначе null. */
export async function staffAttachmentRedirect(ctx: StaffContext, id: unknown, opts: { inline: boolean }): Promise<string | null> {
  const parsed = attachmentIdInput.safeParse(id);
  if (!parsed.success) return null;
  const row = await findStaffDownloadableTx(ctx.actor, parsed.data);
  if (!row) return null;
  const inline = opts.inline && STAFF_INLINE_TYPES.includes(row.mime);
  return getStorage().presignDownload(row.storageKey, { filename: baseName(row.fileName), contentType: row.mime, ttlSeconds: DOWNLOAD_LINK_TTL_SEC, inline });
}

/** Обработчик GET /api/attachments/{id}?inline=1: клиент по правилам кабинета, сотрудник по правилам рабочего места. */
export async function handleAttachmentRequest(request: Request, id: string): Promise<Response> {
  const inline = new URL(request.url).searchParams.get('inline') === '1';
  const client = await currentClient();
  if (client) return attachmentResponse(client, id, inline);
  const staff = await currentStaff();
  if (!staff) return problemResponse(401, 'unauthenticated');
  const url = await staffAttachmentRedirect(staff, id, { inline });
  if (!url) return problemResponse(404, 'not_found');
  return new Response(null, { status: 303, headers: { Location: url, 'Cache-Control': 'private, no-store' } });
}
