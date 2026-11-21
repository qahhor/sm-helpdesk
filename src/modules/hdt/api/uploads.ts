import 'server-only';
import { env } from '@/env';
import { consumeRateLimit, enqueue, getStorage, isSameOriginJson, problemResponse, rateKey, readLimited } from '@/modules/hdc/api';
import { RATE_RULES } from '@/modules/hdc/pref';
import { type ClientContext, currentClient } from '@/modules/hdu/api';
import { createUploadTx, findOwnUpload, rejectUploadTx } from '../core/attachments';
import { HdtError, isHdtError } from '../error';
import { attachmentIdInput, parseInput, presignUploadInput } from '../input';
import type { ScanStatus } from '../pref';
import { fileTypeOf, maxBytesFor, quarantineKey } from '../util';

// Загрузка файлов к обращениям (FR-TK-13, раздел 11.11, решение 0027). Портал файлы не принимает:
// он создаёт строку в карантине и выдаёт подписанную ссылку, браузер кладёт файл прямо в хранилище,
// затем сообщает о завершении. Проверку на вирусы ставит в очередь completeUpload.

/** Ссылка на загрузку файла: тип по расширению, предел размера, 30 ссылок в час на пользователя. */
export async function presignUpload(
  ctx: ClientContext,
  input: unknown,
): Promise<{ attachmentId: string; url: string; headers: Record<string, string> }> {
  const data = parseInput(presignUploadInput, input);
  const mime = fileTypeOf(data.fileName, data.mime ?? '');
  if (!mime) throw new HdtError('file_not_allowed');
  if (data.size > maxBytesFor(mime)) throw new HdtError('file_too_large');
  const limit = await consumeRateLimit(rateKey('upload-presign:user', ctx.actor.userId), RATE_RULES.uploadPresignPerUser);
  if (!limit.allowed) throw new HdtError('rate_limited', { retryAfterSec: limit.retryAfterSec });
  const attachmentId = await createUploadTx(ctx.actor, { fileName: data.fileName, mime, size: data.size });
  const { url, headers } = await getStorage().presignUpload(quarantineKey(attachmentId), mime, data.size);
  return { attachmentId, url, headers };
}

/**
 * Браузер закончил загрузку. Файла нет или размер не совпал с заявленным: файл удаляется, загрузка rejected.
 * Совпал: ставится задача проверки, загрузка остаётся pending. Повторный вызов безопасен.
 */
export async function completeUpload(ctx: ClientContext, attachmentId: unknown): Promise<{ status: ScanStatus }> {
  const id = parseInput(attachmentIdInput, attachmentId);
  // Каждый вызов смотрит в хранилище и ставит задачу: повторы ограничены (вторая проверка M2).
  const limit = await consumeRateLimit(rateKey('upload-complete:user', ctx.actor.userId), RATE_RULES.uploadCompletePerUser);
  if (!limit.allowed) throw new HdtError('rate_limited', { retryAfterSec: limit.retryAfterSec });
  const upload = await findOwnUpload(ctx.actor, id);
  if (!upload) throw new HdtError('not_found');
  const storage = getStorage();
  if (upload.scanStatus !== 'pending') {
    // Проверка уже закончена, а по живой ссылке файл положили повторно: остаток в карантине удаляется.
    await storage.remove(quarantineKey(id));
    return { status: upload.scanStatus };
  }
  // Загрузка ещё не проверена, значит лежит в карантине. Ключ берётся из идентификатора, а не из строки:
  // проверка и удаление не уйдут на проверенный файл, даже если строку испортили (вторая проверка M2).
  const quarantine = quarantineKey(id);
  const stored = await storage.head(quarantine);
  if (!stored || stored.size !== upload.size) {
    await storage.remove(quarantine);
    await rejectUploadTx(ctx.actor, id);
    return { status: 'rejected' };
  }
  await enqueue('attachment.scan', { attachmentId: id });
  return { status: 'pending' };
}

// --- Обработчики /api/uploads/presign и /api/uploads/complete ---

const STATUS_BY_CODE: Partial<Record<string, number>> = {
  invalid_input: 400,
  file_not_allowed: 415,
  too_many_files: 400,
  file_too_large: 413,
  not_found: 404,
  forbidden: 403,
  rate_limited: 429,
};

/**
 * Общая часть обработчиков: запрос JSON со страницы портала, сессия клиента с организацией, тело до 4 КБ.
 * Ошибки модуля превращаются в ответ application/problem+json с кодом, без подробностей.
 */
export async function handleUploadRequest(request: Request, op: 'presign' | 'complete'): Promise<Response> {
  if (!isSameOriginJson(request, env.HUB_URL)) return problemResponse(403, 'forbidden');
  const ctx = await currentClient();
  if (!ctx) return problemResponse(401, 'unauthenticated');
  const text = await readLimited(request, 4096);
  if (text === null) return problemResponse(413, 'too_large');
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return problemResponse(400, 'invalid_input');
  }
  try {
    const result =
      op === 'presign' ? await presignUpload(ctx, body) : await completeUpload(ctx, (body as { attachmentId?: unknown } | null)?.attachmentId);
    return Response.json(result, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    if (!isHdtError(error)) throw error;
    const headers: Record<string, string> = error.retryAfterSec ? { 'Retry-After': String(error.retryAfterSec) } : {};
    return problemResponse(STATUS_BY_CODE[error.code] ?? 400, error.code, headers);
  }
}
