import { afterEach, beforeEach, expect, test } from 'vitest';
import { MemoryJobQueue, MemoryStorage, setJobQueueForTests, setStorageForTests } from '@/modules/hdc/testing';
import { completeUpload, createTicket, presignUpload, replyToTicket } from '@/modules/hdt/api';
import { MAX_FILE_BYTES, MAX_VIDEO_BYTES } from '@/modules/hdt/pref';
import { RATE_RULES } from '@/modules/hdc/pref';
import { clientCtx } from './helpers/auth';
import { pools } from './helpers/db';
import { seedTwoOrgs } from './isolation/fixture';

// Загрузка файлов в карантин (FR-TK-13, раздел 11.11, решение 0027; план M2, задача 5).

let storage: MemoryStorage;
let jobs: MemoryJobQueue;
beforeEach(() => {
  storage = new MemoryStorage();
  jobs = new MemoryJobQueue();
  setStorageForTests(storage);
  setJobQueueForTests(jobs);
});
afterEach(() => {
  setStorageForTests(null);
  setJobQueueForTests(null);
});

const row = (id: string) =>
  pools.root
    .query(
      `select org_id, ticket_id, uploader_id, storage_key, file_name, mime, size::int as size, scan_status
         from hdt_attachments where attachment_id = $1`,
      [id],
    )
    .then((r) => r.rows[0]);
const uploadsOf = (userId: string) =>
  pools.root.query(`select count(*)::int as n from hdt_attachments where uploader_id = $1`, [userId]).then((r) => r.rows[0].n as number);

test('ссылка на загрузку: разрешённый тип и размер, 31-я за час rate_limited', async () => {
  const f = await seedTwoOrgs();
  const ctx = await clientCtx(f.aUser);
  const before = await uploadsOf(f.aUser.userId);
  const first = await presignUpload(ctx, { fileName: 'Скриншот.PNG', size: 2048, mime: 'image/png' });
  expect(first.headers).toEqual({ 'Content-Type': 'image/png' });
  expect(first.url).toContain(`quarantine/${first.attachmentId}`);
  expect(storage.presigned.at(-1)).toEqual({ key: `quarantine/${first.attachmentId}`, mime: 'image/png', size: 2048 });
  expect(await row(first.attachmentId)).toEqual({
    org_id: f.orgA.orgId,
    ticket_id: null,
    uploader_id: f.aUser.userId,
    storage_key: `quarantine/${first.attachmentId}`,
    file_name: 'Скриншот.PNG',
    mime: 'image/png',
    size: 2048,
    scan_status: 'pending',
  });
  // Тип определяет расширение. Пустой и привычный браузеру другой тип того же файла принимаются,
  // в строку и в подпись попадает тип по расширению.
  const csv = await presignUpload(ctx, { fileName: 'выгрузка.csv', size: 10, mime: 'application/vnd.ms-excel' });
  expect((await row(csv.attachmentId)).mime).toBe('text/csv');
  expect(csv.headers).toEqual({ 'Content-Type': 'text/csv' });
  expect((await row((await presignUpload(ctx, { fileName: 'server.log', size: 10, mime: '' })).attachmentId)).mime).toBe('text/plain');
  expect((await row((await presignUpload(ctx, { fileName: 'отчёт.pdf', size: MAX_FILE_BYTES })).attachmentId)).size).toBe(MAX_FILE_BYTES);
  expect((await row((await presignUpload(ctx, { fileName: 'запись.mp4', size: MAX_VIDEO_BYTES, mime: 'video/mp4' })).attachmentId)).mime).toBe('video/mp4');
  for (let i = 5; i < RATE_RULES.uploadPresignPerUser.limit; i++) await presignUpload(ctx, { fileName: `f${i}.txt`, size: 1 });
  await expect(presignUpload(ctx, { fileName: 'лишний.txt', size: 1 })).rejects.toMatchObject({ code: 'rate_limited' });
  expect(RATE_RULES.uploadPresignPerUser).toEqual({ limit: 30, windowSec: 3600 });
  expect(await uploadsOf(f.aUser.userId)).toBe(before + 30);
});

test('SVG, HTML, неизвестное расширение и файл больше 25 МБ (MP4 больше 50 МБ) отклоняются', async () => {
  const f = await seedTwoOrgs();
  const ctx = await clientCtx(f.aUser);
  const before = await uploadsOf(f.aUser.userId);
  const refused = [
    [{ fileName: 'logo.svg', size: 10, mime: 'image/svg+xml' }, 'file_not_allowed'],
    [{ fileName: 'page.html', size: 10, mime: 'text/html' }, 'file_not_allowed'],
    [{ fileName: 'page.htm', size: 10 }, 'file_not_allowed'],
    [{ fileName: 'shot.png', size: 10, mime: 'text/html' }, 'file_not_allowed'],
    [{ fileName: 'archive.rar', size: 10 }, 'file_not_allowed'],
    [{ fileName: 'README', size: 10 }, 'file_not_allowed'],
    [{ fileName: 'big.pdf', size: MAX_FILE_BYTES + 1, mime: 'application/pdf' }, 'file_too_large'],
    [{ fileName: 'clip.mp4', size: MAX_VIDEO_BYTES + 1, mime: 'video/mp4' }, 'file_too_large'],
    [{ fileName: 'empty.txt', size: 0 }, 'invalid_input'],
    [{ fileName: '', size: 1 }, 'invalid_input'],
    [{ fileName: '../etc/passwd.txt', size: 1 }, 'invalid_input'],
    [{ fileName: 'a\u0000.txt', size: 1 }, 'invalid_input'],
  ] as const;
  for (const [input, code] of refused) await expect(presignUpload(ctx, input), input.fileName).rejects.toMatchObject({ code });
  expect(MAX_FILE_BYTES).toBe(25 * 1024 * 1024);
  expect(MAX_VIDEO_BYTES).toBe(50 * 1024 * 1024);
  // Видео до 50 МБ проходит, отклонённые строк и ссылок не оставили.
  await presignUpload(ctx, { fileName: 'clip.mp4', size: MAX_FILE_BYTES + 1, mime: 'video/mp4' });
  expect(await uploadsOf(f.aUser.userId)).toBe(before + 1);
  expect(storage.presigned).toHaveLength(1);
});

test('загрузка завершена: размер не совпал с заявленным - rejected и файл удалён (на что смотреть, 1)', async () => {
  const f = await seedTwoOrgs();
  const ctx = await clientCtx(f.aUser);
  const short = await presignUpload(ctx, { fileName: 'shot.png', size: 2048, mime: 'image/png' });
  storage.put(`quarantine/${short.attachmentId}`, new Uint8Array(1000));
  expect(await completeUpload(ctx, short.attachmentId)).toEqual({ status: 'rejected' });
  expect((await row(short.attachmentId)).scan_status).toBe('rejected');
  expect(storage.has(`quarantine/${short.attachmentId}`)).toBe(false);
  // Файл так и не загрузили: тоже rejected. Повторное завершение возвращает то же состояние.
  const missing = await presignUpload(ctx, { fileName: 'shot.png', size: 10, mime: 'image/png' });
  expect(await completeUpload(ctx, missing.attachmentId)).toEqual({ status: 'rejected' });
  expect(await completeUpload(ctx, missing.attachmentId)).toEqual({ status: 'rejected' });
  expect(jobs.sent).toEqual([]);
  // Отклонённый файл к обращению не прикрепляется.
  await expect(
    createTicket(ctx, { description: 'С отклонённым файлом', type: 'bug', impact: 'minor', locale: 'ru', attachmentIds: [short.attachmentId] }),
  ).rejects.toMatchObject({ code: 'file_unavailable' });
  await expect(replyToTicket(ctx, { number: f.tickets.aOrg.number, body: 'Файл', attachmentIds: [short.attachmentId] })).rejects.toMatchObject({
    code: 'file_unavailable',
  });
  // Размер совпал: файл остаётся в карантине, ставится задача проверки.
  const good = await presignUpload(ctx, { fileName: 'shot.png', size: 2048, mime: 'image/png' });
  storage.put(`quarantine/${good.attachmentId}`, new Uint8Array(2048));
  expect(await completeUpload(ctx, good.attachmentId)).toEqual({ status: 'pending' });
  expect(storage.has(`quarantine/${good.attachmentId}`)).toBe(true);
  expect(jobs.sent).toEqual([{ name: 'attachment.scan', data: { attachmentId: good.attachmentId } }]);
  expect((await row(good.attachmentId)).scan_status).toBe('pending');
});

test('очередь недоступна: загрузка завершается, файл ждёт обхода, ошибка только в журнале процесса', async () => {
  const f = await seedTwoOrgs();
  const ctx = await clientCtx(f.aUser);
  setJobQueueForTests({ send: async () => Promise.reject(new Error('очередь недоступна')) });
  const errors: unknown[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => void errors.push(args.join(' '));
  try {
    const { attachmentId } = await presignUpload(ctx, { fileName: 'shot.png', size: 4, mime: 'image/png' });
    storage.put(`quarantine/${attachmentId}`, new Uint8Array(4));
    expect(await completeUpload(ctx, attachmentId)).toEqual({ status: 'pending' });
    expect(errors.join('\n')).toMatch(/attachment\.scan/);
    expect(errors.join('\n')).not.toMatch(/shot\.png/);
  } finally {
    console.error = original;
  }
});

test('форма, открытая дольше суток: файл уже удалён обходом, отказ называет файл, а не "проверьте поля"', async () => {
  const f = await seedTwoOrgs();
  const ctx = await clientCtx(f.aUser);
  const { attachmentId } = await presignUpload(ctx, { fileName: 'shot.png', size: 4, mime: 'image/png' });
  // Обход удалил неприкреплённую загрузку старше суток.
  await pools.root.query(`delete from hdt_attachments where attachment_id = $1`, [attachmentId]);
  const ticket = { description: 'Форма была открыта со вчера', type: 'bug', impact: 'minor', locale: 'ru', attachmentIds: [attachmentId] };
  await expect(createTicket(ctx, ticket)).rejects.toMatchObject({ code: 'file_unavailable' });
  await expect(replyToTicket(ctx, { number: f.tickets.aOrg.number, body: 'Ответ с файлом', attachmentIds: [attachmentId] })).rejects.toMatchObject({
    code: 'file_unavailable',
  });
  // Ни обращение, ни ответ не сохранились.
  expect((await pools.root.query(`select count(*)::int as n from hdt_tickets where description = $1`, [ticket.description])).rows[0].n).toBe(0);
  expect((await pools.root.query(`select count(*)::int as n from hdt_ticket_messages where body = 'Ответ с файлом'`)).rows[0].n).toBe(0);
});

test('чужую загрузку завершить нельзя, неприкреплённая видна только загрузившему', async () => {
  const f = await seedTwoOrgs();
  const mine = await presignUpload(await clientCtx(f.aUser), { fileName: 'shot.png', size: 4, mime: 'image/png' });
  storage.put(`quarantine/${mine.attachmentId}`, new Uint8Array(4));
  for (const member of [f.aAdmin, f.bUser])
    await expect(completeUpload(await clientCtx(member), mine.attachmentId)).rejects.toMatchObject({ code: 'not_found' });
  await expect(completeUpload(await clientCtx(f.aUser), 'не идентификатор')).rejects.toMatchObject({ code: 'invalid_input' });
  // Коллега не прикрепит чужую загрузку к своему обращению.
  await expect(
    createTicket(await clientCtx(f.aAdmin), { description: 'С чужим файлом', type: 'bug', impact: 'minor', locale: 'ru', attachmentIds: [mine.attachmentId] }),
  ).rejects.toMatchObject({ code: 'file_unavailable' });
  expect((await row(mine.attachmentId)).scan_status).toBe('pending');
  expect(storage.has(`quarantine/${mine.attachmentId}`)).toBe(true);
  expect(jobs.sent).toEqual([]);
});
