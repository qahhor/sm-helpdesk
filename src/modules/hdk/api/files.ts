import 'server-only';
import * as z from 'zod';
import type { SystemActor } from '@/db/with-actor';
import { withActor } from '@/db/with-actor';
import { consumeRateLimit, contentDisposition, enqueue, getStorage, problemResponse, rateKey, type StaffContext, sweepPendingScans } from '@/modules/hdc/api';
import { RATE_RULES } from '@/modules/hdc/pref';
import { articleByNumberTx, createFileTx, fileByIdTx, type FileRow } from '../core/editor';
import { pendingFiles, rejectStuckFiles, scanFile } from '../core/files';
import { HdkError } from '../error';
import { ARTICLE_NUMBER_MAX, FILE_MAX_BYTES, FILE_MIMES, fileQuarantineKey, type FileScanStatus, KB_WRITER_ROLES } from '../pref';

// Модуль hdk, слой api: изображения решения (UX-W-03; план M5, решения 13 и 16). Загрузка как у вложений обращений
// (решение 0027): строка в карантине, подписанная ссылка, браузер кладёт файл прямо в хранилище, затем "загрузка
// завершена" ставит проверку антивирусом (задача kb.scan). Показывается только чистый файл. Сотрудник получает файл
// через обработчик рабочего места, клиент только через страницу опубликованного решения (задача 4).

function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const parsed = schema.safeParse(input);
  if (!parsed.success) throw new HdkError('invalid_input');
  return parsed.data;
}

function requireWriter(ctx: StaffContext): void {
  if (ctx.actor.type !== 'staff' || !(KB_WRITER_ROLES as readonly string[]).includes(ctx.actor.staffRole)) throw new HdkError('forbidden');
}

const number = z.coerce.number().int().positive().max(ARTICLE_NUMBER_MAX);
const presignInput = z.strictObject({
  number,
  fileName: z.string().trim().min(1).max(255),
  mime: z.enum(FILE_MIMES),
  size: z.int().min(1),
});
const fileInput = z.strictObject({ fileId: z.uuid() });

export type PresignedFile = {
  fileId: string;
  url: string;
  headers: Record<string, string>;
};

/** Ссылка на загрузку изображения решения: PNG, JPEG, WebP до 10 МБ, 30 ссылок в час на сотрудника. */
export async function presignSolutionFile(ctx: StaffContext, input: unknown): Promise<PresignedFile> {
  requireWriter(ctx);
  const data = parse(presignInput, input);
  if (data.size > FILE_MAX_BYTES) throw new HdkError('file_too_large');
  const limit = await consumeRateLimit(rateKey('kb-upload-presign:user', ctx.actor.userId), RATE_RULES.uploadPresignPerUser);
  if (!limit.allowed) throw new HdkError('rate_limited', { retryAfterSec: limit.retryAfterSec });
  const fileId = await withActor(ctx.actor, async (tx) => {
    const article = await articleByNumberTx(tx, data.number);
    if (!article) throw new HdkError('not_found');
    return createFileTx(tx, article.articleId, {
      fileName: data.fileName,
      mime: data.mime,
      size: data.size,
    });
  });
  const { url, headers } = await getStorage().presignUpload(fileQuarantineKey(fileId), data.mime, data.size);
  return { fileId, url, headers };
}

/** Браузер закончил загрузку: размер сверяется, ставится проверка. Повторный вызов безопасен. */
export async function completeSolutionFile(ctx: StaffContext, input: unknown): Promise<{ status: FileScanStatus }> {
  requireWriter(ctx);
  const { fileId } = parse(fileInput, input);
  const limit = await consumeRateLimit(rateKey('kb-upload-complete:user', ctx.actor.userId), RATE_RULES.uploadCompletePerUser);
  if (!limit.allowed) throw new HdkError('rate_limited', { retryAfterSec: limit.retryAfterSec });
  const row = await withActor(ctx.actor, (tx) => fileByIdTx(tx, fileId));
  if (!row) throw new HdkError('not_found');
  if (row.scanStatus !== 'pending') return { status: row.scanStatus };
  const stored = await getStorage().head(fileQuarantineKey(fileId));
  // Файла нет или он другого размера: проверка его отклонит, ставится сразу (строку меняет только система).
  if (!stored || stored.size !== row.size) await getStorage().remove(fileQuarantineKey(fileId));
  await enqueue('kb.scan', { fileId });
  return { status: 'pending' };
}

/** Состояние проверки: страница ждёт clean, чтобы вставить изображение в шаг. */
export async function solutionFileStatus(ctx: StaffContext, input: unknown): Promise<{ status: FileScanStatus }> {
  const { fileId } = parse(fileInput, input);
  const row = await withActor(ctx.actor, (tx) => fileByIdTx(tx, fileId));
  if (!row) throw new HdkError('not_found');
  return { status: row.scanStatus };
}

/** Задача kb.scan фонового процесса. null: строки уже нет. */
export function scanSolutionFile(actor: SystemActor, fileId: string): Promise<FileScanStatus | null> {
  return scanFile(actor, fileId);
}

/**
 * Файл из хранилища потоком: тип задаёт портал, показ на странице, без угадывания типа браузером и без кеша.
 * Только чистый файл с постоянным ключом.
 */
export async function streamFileResponse(row: FileRow): Promise<Response> {
  if (row.scanStatus !== 'clean' || !row.storageKey.startsWith('files/kb/')) return problemResponse(404, 'not_found');
  const { body } = await getStorage().stream(row.storageKey);
  return new Response(body, {
    status: 200,
    headers: {
      'Content-Type': row.mime,
      'Content-Length': String(row.size),
      'Content-Disposition': contentDisposition('inline', row.fileName),
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'private, no-store',
    },
  });
}

/** GET /agent/solutions/{номер}/files/{id}: любой сотрудник, файл этой статьи, только чистый. */
export async function staffSolutionFileResponse(ctx: StaffContext | null, input: { number: string; fileId: string }): Promise<Response> {
  if (!ctx) return problemResponse(401, 'unauthenticated');
  const parsed = z.strictObject({ number, fileId: z.uuid() }).safeParse(input);
  if (!parsed.success) return problemResponse(404, 'not_found');
  const row = await withActor(ctx.actor, async (tx) => {
    const article = await articleByNumberTx(tx, parsed.data.number);
    const file = article ? await fileByIdTx(tx, parsed.data.fileId) : null;
    return file && article && file.articleId === article.articleId ? file : null;
  });
  if (!row) return problemResponse(404, 'not_found');
  return streamFileResponse(row);
}

/**
 * Обход зависших проверок изображений решений (проверка качества, Q5): задача attachment.sweep раз в минуту. Файл
 * pending старше двух минут ставится на проверку снова, старше суток не принимается.
 */
export async function sweepSolutionFiles(actor: SystemActor, now: Date = new Date()): Promise<{ requeued: number; failed: number }> {
  if (actor.type !== 'system') throw new HdkError('forbidden');
  return sweepPendingScans(
    {
      name: 'kb',
      rejectStuck: (before, limit) => rejectStuckFiles(actor, before, limit),
      listPending: (before, limit) => pendingFiles(actor, before, limit),
      quarantineKey: fileQuarantineKey,
      enqueue: (fileId) => enqueue('kb.scan', { fileId }),
    },
    now,
  );
}
