import { afterEach, beforeEach, expect, test } from 'vitest';
import { createHash } from 'node:crypto';
import type { AntivirusScanner } from '@/modules/hdc/api';
import { MemoryJobQueue, MemoryStorage, setJobQueueForTests, setScannerForTests, setStorageForTests } from '@/modules/hdc/testing';
import { createStubScanner } from '@/modules/hdc/antivirus/stub';
import { completeUpload, presignUpload, scanAttachment } from '@/modules/hdt/api';
import { EICAR } from '../helpers/fake-clamd';
import { clientCtx } from './helpers/auth';
import { pools } from './helpers/db';
import { seedTwoOrgs } from './isolation/fixture';

const SYSTEM = { type: 'system', job: 'attachment.scan' } as const;

// Проверка вложения фоновой задачей (раздел 11.11, угроза T6, решение 0027; план M2, задача 6).

let storage: MemoryStorage;
let scans: number;
const counting = (inner: AntivirusScanner): AntivirusScanner => ({
  scan: (stream) => {
    scans++;
    return inner.scan(stream);
  },
});
beforeEach(() => {
  storage = new MemoryStorage();
  scans = 0;
  setStorageForTests(storage);
  setJobQueueForTests(new MemoryJobQueue());
  setScannerForTests(counting(createStubScanner()));
});
afterEach(() => {
  setStorageForTests(null);
  setJobQueueForTests(null);
  setScannerForTests(null);
});

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...new Array(56).fill(7)]);
const text = (value: string) => new TextEncoder().encode(value);
const row = (id: string) =>
  pools.root
    .query(`select org_id, storage_key, scan_status, scan_signature, detected_type, sha256 from hdt_attachments where attachment_id = $1`, [id])
    .then((r) => r.rows[0]);

/** Загрузка, как её делает браузер: ссылка, файл в хранилище, "загрузка завершена". */
async function upload(member: { userId: string }, fileName: string, mime: string, bytes: Uint8Array): Promise<string> {
  const ctx = await clientCtx(member);
  const { attachmentId } = await presignUpload(ctx, { fileName, size: bytes.byteLength, mime });
  storage.put(`quarantine/${attachmentId}`, bytes);
  expect(await completeUpload(ctx, attachmentId)).toEqual({ status: 'pending' });
  return attachmentId;
}

test('чистый файл переносится из карантина и получает clean', async () => {
  const f = await seedTwoOrgs();
  const id = await upload(f.aUser, 'shot.png', 'image/png', PNG);
  expect(await scanAttachment(SYSTEM, id)).toBe('clean');
  expect(await row(id)).toEqual({
    org_id: f.orgA.orgId,
    storage_key: `files/${f.orgA.orgId}/${id}`,
    scan_status: 'clean',
    scan_signature: null,
    detected_type: 'png',
    sha256: createHash('sha256').update(PNG).digest('hex'),
  });
  expect(storage.has(`quarantine/${id}`)).toBe(false);
  expect(storage.has(`files/${f.orgA.orgId}/${id}`)).toBe(true);
  // Повторный вызов ничего не меняет и антивирус не зовёт.
  expect(await scanAttachment(SYSTEM, id)).toBe('clean');
  expect(scans).toBe(1);
  // Офисный файл это ZIP, текст без нулевых байтов, CSV тоже текст.
  const docx = await upload(f.aUser, 'отчёт.docx', '', new Uint8Array([0x50, 0x4b, 0x03, 0x04, ...new Array(60).fill(1)]));
  expect(await scanAttachment(SYSTEM, docx)).toBe('clean');
  expect(await scanAttachment(SYSTEM, await upload(f.aUser, 'выгрузка.csv', 'text/csv', text('код;имя\n1;Заказ\n')))).toBe('clean');
});

test('EICAR получает infected, объект из карантина удалён, файл не скачивается', async () => {
  const f = await seedTwoOrgs();
  const id = await upload(f.aUser, 'readme.txt', 'text/plain', text(EICAR));
  expect(await scanAttachment(SYSTEM, id)).toBe('infected');
  expect(await row(id)).toMatchObject({ scan_status: 'infected', scan_signature: 'Eicar-Test-Signature', storage_key: `quarantine/${id}` });
  expect(storage.objects.size).toBe(0);
  // Заражённый файл записан в журнал аудита вместе с организацией и подписью.
  const audit = await pools.root.query(`select action, object_type, org_id, diff from hdc_audit_log where object_id = $1`, [id]);
  expect(audit.rows).toEqual([{ action: 'attachment.infected', object_type: 'attachment', org_id: f.orgA.orgId, diff: { signature: 'Eicar-Test-Signature' } }]);
  expect(await scanAttachment(SYSTEM, id)).toBe('infected');
  expect(scans).toBe(1);
});

test('законные файлы не отклоняются: журнал в UTF-16, офисный файл с паролем, PNG с расширением .jpg', async () => {
  const f = await seedTwoOrgs();
  const utf16 = new Uint8Array([0xff, 0xfe, ...Array.from(Buffer.from('2026-11-21 ошибка синхронизации\r\n', 'utf16le'))]);
  expect(await scanAttachment(SYSTEM, await upload(f.aUser, 'sync.log', 'text/plain', utf16))).toBe('clean');
  // Файл Office с паролем хранится в контейнере OLE, а не в ZIP.
  const ole = new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, ...new Array(56).fill(0)]);
  expect(await scanAttachment(SYSTEM, await upload(f.aUser, 'отчёт с паролем.xlsx', '', ole))).toBe('clean');
  const jpg = await upload(f.aUser, 'screen.jpg', 'image/jpeg', PNG);
  expect(await scanAttachment(SYSTEM, jpg)).toBe('clean');
  expect((await row(jpg)).detected_type).toBe('png');
  // Исполняемый файл под видом картинки по-прежнему не принимается.
  expect(await scanAttachment(SYSTEM, await upload(f.aUser, 'photo.jpg', 'image/jpeg', text('MZ\x90\0\x03\0\0\0')))).toBe('rejected');
});

test('report.pdf с HTML внутри получает rejected (на что смотреть, 1)', async () => {
  const f = await seedTwoOrgs();
  const id = await upload(f.aUser, 'report.pdf', 'application/pdf', text('<!DOCTYPE html><html><script>alert(1)</script></html>'));
  expect(await scanAttachment(SYSTEM, id)).toBe('rejected');
  expect(await row(id)).toMatchObject({ scan_status: 'rejected', detected_type: 'html' });
  expect(storage.objects.size).toBe(0);
  // Исполняемый файл под видом документа и SVG под видом картинки тоже, антивирус до них не доходит.
  expect(await scanAttachment(SYSTEM, await upload(f.aUser, 'invoice.docx', '', text('MZ\x90\0\x03\0\0\0')))).toBe('rejected');
  expect(await scanAttachment(SYSTEM, await upload(f.aUser, 'logo.png', 'image/png', text('<svg xmlns="http://www.w3.org/2000/svg"/>')))).toBe('rejected');
  expect(scans).toBe(0);
});

test('антивирус не ответил: статус pending, ошибка для повтора задачи (на что смотреть, 2)', async () => {
  const f = await seedTwoOrgs();
  const id = await upload(f.aUser, 'shot.png', 'image/png', PNG);
  setScannerForTests({ scan: async () => Promise.reject(new Error('ClamAV: нет ответа')) });
  await expect(scanAttachment(SYSTEM, id)).rejects.toThrow(/ClamAV/);
  expect((await row(id)).scan_status).toBe('pending');
  expect(storage.has(`quarantine/${id}`)).toBe(true);
  // Повтор задачи после восстановления антивируса доводит проверку до конца.
  setScannerForTests(createStubScanner());
  expect(await scanAttachment(SYSTEM, id)).toBe('clean');
});

test('файл подменили во время проверки: перенос не происходит, повторная проверка оценивает новый файл (угроза T6)', async () => {
  const f = await seedTwoOrgs();
  const id = await upload(f.aUser, 'отчёт.txt', 'text/plain', text('a'.repeat(EICAR.length)));
  // Пока антивирус читает файл, загрузивший кладёт по той же ссылке другой файл того же размера и типа.
  const swapped = text(EICAR);
  setScannerForTests({
    scan: async (stream) => {
      storage.put(`quarantine/${id}`, swapped);
      return createStubScanner().scan(stream);
    },
  });
  await expect(scanAttachment(SYSTEM, id)).rejects.toThrow();
  expect((await row(id)).scan_status).toBe('pending');
  expect(storage.has(`files/${f.orgA.orgId}/${id}`)).toBe(false);
  // Повтор задачи проверяет уже новый файл, и антивирус его находит.
  setScannerForTests(createStubScanner());
  expect(await scanAttachment(SYSTEM, id)).toBe('infected');
  expect(storage.has(`files/${f.orgA.orgId}/${id}`)).toBe(false);
  // Файл другого размера после чтения тоже не становится чистым.
  const resized = await upload(f.aUser, 'журнал.txt', 'text/plain', text('b'.repeat(40)));
  storage.put(`quarantine/${resized}`, text('b'.repeat(41)));
  expect(await scanAttachment(SYSTEM, resized)).toBe('rejected');
});

test('обрыв после переноса: повтор отмечает clean без второй проверки, пропавший файл получает rejected', async () => {
  const f = await seedTwoOrgs();
  const moved = await upload(f.aUser, 'shot.png', 'image/png', PNG);
  await storage.move(`quarantine/${moved}`, `files/${f.orgA.orgId}/${moved}`);
  expect(await scanAttachment(SYSTEM, moved)).toBe('clean');
  expect((await row(moved)).storage_key).toBe(`files/${f.orgA.orgId}/${moved}`);
  const lost = await upload(f.aUser, 'shot.png', 'image/png', PNG);
  await storage.remove(`quarantine/${lost}`);
  expect(await scanAttachment(SYSTEM, lost)).toBe('rejected');
  expect(scans).toBe(0);
  await expect(scanAttachment(SYSTEM, '0192d2a4-0000-7000-8000-000000000000')).rejects.toMatchObject({ code: 'not_found' });
});
