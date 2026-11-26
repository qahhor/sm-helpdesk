import 'server-only';
import * as z from 'zod';
import type { ClientActor, StaffActor } from '@/db/with-actor';
import { withActor } from '@/db/with-actor';
import { contentDisposition, getStorage, problemResponse } from '@/modules/hdc/api';
import { ideaFileTx } from '../core/files';
import { ideaNumber } from '../input';

// Модуль hdi, слой api: показ изображения идеи (план M7, решение 10). Клиенту политика отдаёт свои загрузки и чужие
// только чистые у опубликованной идеи; отдаётся всегда только чистый файл из files/ideas/. Сотруднику: любой чистый
// файл видимой идеи. Тип задаёт портал, угадывать его браузеру запрещено, кеш отключён.

const fileInput = z.strictObject({ number: ideaNumber, fileId: z.uuid() });

export async function ideaFileResponse(actor: ClientActor | StaffActor | null, input: { number: string; fileId: string }): Promise<Response> {
  if (!actor) return problemResponse(401, 'unauthenticated');
  const parsed = fileInput.safeParse(input);
  if (!parsed.success) return problemResponse(404, 'not_found');
  const row = await withActor(actor, (tx) => ideaFileTx(tx, parsed.data.number, parsed.data.fileId));
  if (!row || row.scanStatus !== 'clean' || !row.storageKey.startsWith('files/ideas/')) return problemResponse(404, 'not_found');
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
