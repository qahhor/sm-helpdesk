import 'server-only';
import { type SystemActor, withActor } from '@/db/with-actor';
import { env } from '@/env';
import { consumeRateLimit, enqueue, getStorage, isSameOriginJson, problemResponse, rateKey, readLimited, sweepPendingScans } from '@/modules/hdc/api';
import { RATE_RULES } from '@/modules/hdc/pref';
import { type ClientContext, currentClient } from '@/modules/hdu/api';
import { createUploadTx, ownUploadTx, pendingUploads, rejectStuckUploads, rejectUpload } from '../core/files';
import { HdiError, isHdiError } from '../error';
import { attachmentInput, parseInput, presignInput } from '../input';
import { IDEA_FILE_MAX_BYTES, type IdeaFileMime, ideaQuarantineKey, type IdeaScanStatus } from '../pref';

// Модуль hdi, слой api: загрузка изображений идеи (план M7, решение 10). Те же обработчики /api/uploads/presign и
// /api/uploads/complete, что у обращений, с целью "idea" в теле: страница обращения и форма идеи пользуются одним
// выбором файлов. Только клиент портала (не виджет и не сотрудник), только PNG, JPEG, WebP до 5 МБ, ссылки считаются
// общим пределом 30 в час (раздел 14.5). Файл до проверки антивирусом виден только загрузившему.

const BY_EXTENSION: Record<string, IdeaFileMime> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp' };

/** Тип по расширению; заявленный браузером тип, если есть, должен совпасть. SVG и прочее: null. */
export function ideaFileType(fileName: string, declared: string | undefined): IdeaFileMime | null {
  const extension = fileName.toLowerCase().split('.').pop() ?? '';
  const mime = BY_EXTENSION[extension];
  if (!mime) return null;
  if (declared && declared !== mime && !(mime === 'image/jpeg' && declared === 'image/jpg')) return null;
  return mime;
}

type Presigned = { attachmentId: string; url: string; headers: Record<string, string> };

export async function presignIdeaUpload(ctx: Pick<ClientContext, 'actor'>, input: unknown): Promise<Presigned> {
  const data = parseInput(presignInput, input);
  const mime = ideaFileType(data.fileName, data.mime);
  if (!mime) throw new HdiError('file_not_allowed');
  if (data.size > IDEA_FILE_MAX_BYTES) throw new HdiError('file_too_large');
  // Тот же счётчик, что у вложений обращений: предел 14.5 общий на пользователя.
  const limit = await consumeRateLimit(rateKey('upload-presign:user', ctx.actor.userId), RATE_RULES.uploadPresignPerUser);
  if (!limit.allowed) throw new HdiError('rate_limited', { retryAfterSec: limit.retryAfterSec });
  const attachmentId = await withActor(ctx.actor, (tx) => createUploadTx(tx, ctx.actor, { fileName: data.fileName, mime, size: data.size }));
  const { url, headers } = await getStorage().presignUpload(ideaQuarantineKey(attachmentId), mime, data.size);
  return { attachmentId, url, headers };
}

/** Браузер закончил загрузку: размер сверяется, ставится проверка ideas.scan. Повторный вызов безопасен. */
export async function completeIdeaUpload(ctx: Pick<ClientContext, 'actor'>, input: unknown): Promise<{ status: IdeaScanStatus }> {
  const { attachmentId } = parseInput(attachmentInput, input);
  const limit = await consumeRateLimit(rateKey('upload-complete:user', ctx.actor.userId), RATE_RULES.uploadCompletePerUser);
  if (!limit.allowed) throw new HdiError('rate_limited', { retryAfterSec: limit.retryAfterSec });
  const upload = await withActor(ctx.actor, (tx) => ownUploadTx(tx, ctx.actor, attachmentId));
  if (!upload) throw new HdiError('not_found');
  const storage = getStorage();
  if (upload.scanStatus !== 'pending') {
    await storage.remove(ideaQuarantineKey(attachmentId));
    return { status: upload.scanStatus };
  }
  const stored = await storage.head(ideaQuarantineKey(attachmentId));
  if (!stored || stored.size !== upload.size) {
    await storage.remove(ideaQuarantineKey(attachmentId));
    await rejectUpload({ type: 'system', job: 'ideas.upload' }, attachmentId);
    return { status: 'rejected' };
  }
  await enqueue('ideas.scan', { attachmentId });
  return { status: 'pending' };
}

/** Запрос загрузки идеи: в теле purpose = "idea". Тело читается из копии запроса, сам запрос не тратится. */
export async function isIdeaUploadRequest(request: Request): Promise<boolean> {
  const text = await readLimited(request.clone(), 4096).catch(() => null);
  if (!text) return false;
  try {
    return (JSON.parse(text) as { purpose?: unknown } | null)?.purpose === 'idea';
  } catch {
    return false;
  }
}

const STATUS_BY_CODE: Partial<Record<string, number>> = {
  invalid_input: 400,
  file_not_allowed: 415,
  file_too_large: 413,
  not_found: 404,
  forbidden: 403,
  rate_limited: 429,
};

/** Обработчик загрузки изображения идеи: запрос JSON со страницы портала, сессия клиента, тело до 4 КБ. */
export async function handleIdeaUploadRequest(request: Request, op: 'presign' | 'complete'): Promise<Response> {
  if (!isSameOriginJson(request, env.HUB_URL)) return problemResponse(403, 'forbidden');
  // Виджет (токен в заголовке) идей не подаёт: сессия портала по его запросу не читается.
  if (request.headers.has('authorization')) return problemResponse(403, 'forbidden');
  const client = await currentClient();
  if (!client) return problemResponse(401, 'unauthenticated');
  const text = await readLimited(request, 4096);
  if (text === null) return problemResponse(413, 'too_large');
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return problemResponse(400, 'invalid_input');
  }
  try {
    const result = op === 'presign' ? await presignIdeaUpload(client, body) : await completeIdeaUpload(client, body);
    return Response.json(result, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    if (!isHdiError(error)) throw error;
    const headers: Record<string, string> = error.retryAfterSec ? { 'Retry-After': String(error.retryAfterSec) } : {};
    return problemResponse(STATUS_BY_CODE[error.code] ?? 400, error.code, headers);
  }
}

/**
 * Обход зависших проверок изображений идей (проверка качества, Q5): задача attachment.sweep раз в минуту. Загрузка
 * pending старше двух минут ставится на проверку снова, старше суток не принимается.
 */
export async function sweepIdeaUploads(actor: SystemActor, now: Date = new Date()): Promise<{ requeued: number; failed: number }> {
  if (actor.type !== 'system') throw new HdiError('forbidden');
  return sweepPendingScans(
    {
      name: 'ideas',
      rejectStuck: (before, limit) => rejectStuckUploads(actor, before, limit),
      listPending: (before, limit) => pendingUploads(actor, before, limit),
      quarantineKey: ideaQuarantineKey,
      enqueue: (attachmentId) => enqueue('ideas.scan', { attachmentId }),
    },
    now,
  );
}
