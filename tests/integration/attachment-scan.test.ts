import { afterEach, beforeEach, expect, test } from 'vitest';
import { createHash } from 'node:crypto';
import type { AntivirusScanner } from '@/modules/hdc/api';
import { MemoryJobQueue, MemoryStorage, setJobQueueForTests, setScannerForTests, setStorageForTests } from '@/modules/hdc/testing';
import { createStubScanner } from '@/modules/hdc/antivirus/stub';
import { completeUpload, createTicket, getTicket, presignUpload, scanAttachment } from '@/modules/hdt/api';
import { infectedSince } from '@/modules/hdt/api/jobs';
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
const OLE = new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, ...new Array(56).fill(0)]);
const ZIP = new Uint8Array([0x50, 0x4b, 0x03, 0x04, ...new Array(60).fill(1)]);
const row = (id: string) =>
  pools.root
    .query(`select org_id, storage_key, scan_status, scan_signature, detected_type, sha256 from hdt_attachments where attachment_id = $1`, [id])
    .then((r) => r.rows[0]);

/** Загрузка, как её делает браузер: ссылка, файл в хранилище, "загрузка завершена". */
async function upload(member: { userId: string }, fileName: string, mime: string, bytes: Uint8Array): Promise<string> {
  const ctx = await clientCtx(member);
  const { attachmentId } = await presignUpload(ctx, { fileName, size: bytes.byteLength, mime });
  storage.seed(`quarantine/${attachmentId}`, bytes);
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
  // Копия получает тип файла от портала, а не метаданные загрузки.
  expect(storage.contentTypes.get(`files/${f.orgA.orgId}/${id}`)).toBe('image/png');
});

test('файл, положенный по ссылке повторно после проверки, не остаётся в карантине без строки', async () => {
  const f = await seedTwoOrgs();
  const ctx = await clientCtx(f.aUser);
  const id = await upload(f.aUser, 'shot.png', 'image/png', PNG);
  expect(await scanAttachment(SYSTEM, id)).toBe('clean');
  // Ссылка ещё жива: тот же файл положили второй раз и снова сообщили о завершении.
  storage.seed(`quarantine/${id}`, PNG);
  expect(await completeUpload(ctx, id)).toEqual({ status: 'clean' });
  expect(storage.has(`quarantine/${id}`)).toBe(false);
  // И повторная задача проверки тоже убирает остаток, перенесённый файл не трогает.
  storage.seed(`quarantine/${id}`, PNG);
  expect(await scanAttachment(SYSTEM, id)).toBe('clean');
  expect(storage.has(`quarantine/${id}`)).toBe(false);
  expect(storage.has(`files/${f.orgA.orgId}/${id}`)).toBe(true);
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
  // Время проверки записано: по нему считается сигнал дежурным о заражённых файлах (проверка волны 3).
  expect((await pools.root.query(`select scanned_on > now() - interval '1 minute' as fresh from hdt_attachments where attachment_id = $1`, [id])).rows[0].fresh).toBe(true);
  expect(await infectedSince(SYSTEM, new Date(Date.now() - 3_600_000))).toBe(1);
});

test('законные файлы не отклоняются: журнал в UTF-16, старый формат Office, PNG с расширением .jpg', async () => {
  const f = await seedTwoOrgs();
  const utf16 = new Uint8Array([0xff, 0xfe, ...Array.from(Buffer.from('2026-11-21 ошибка синхронизации\r\n', 'utf16le'))]);
  expect(await scanAttachment(SYSTEM, await upload(f.aUser, 'sync.log', 'text/plain', utf16))).toBe('clean');
  // Старый формат Office это контейнер OLE.
  expect(await scanAttachment(SYSTEM, await upload(f.aUser, 'отчёт.xls', '', OLE))).toBe('clean');
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
      storage.seed(`quarantine/${id}`, swapped);
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
  storage.seed(`quarantine/${resized}`, text('b'.repeat(41)));
  expect(await scanAttachment(SYSTEM, resized)).toBe('rejected');
});

test('обрыв после переноса: повтор отмечает clean без второй проверки, пропавший файл получает rejected', async () => {
  const f = await seedTwoOrgs();
  const moved = await upload(f.aUser, 'shot.png', 'image/png', PNG);
  await storage.move(`quarantine/${moved}`, `files/${f.orgA.orgId}/${moved}`, { contentType: 'image/png' });
  expect(await scanAttachment(SYSTEM, moved)).toBe('clean');
  expect((await row(moved)).storage_key).toBe(`files/${f.orgA.orgId}/${moved}`);
  const lost = await upload(f.aUser, 'shot.png', 'image/png', PNG);
  await storage.remove(`quarantine/${lost}`);
  expect(await scanAttachment(SYSTEM, lost)).toBe('rejected');
  expect(scans).toBe(0);
  await expect(scanAttachment(SYSTEM, '0192d2a4-0000-7000-8000-000000000000')).rejects.toMatchObject({ code: 'not_found' });
});

test('зашифрованный файл и архив сверх пределов проверки: rejected с причиной, а не infected (решение 0027, пункт 20)', async () => {
  const f = await seedTwoOrgs();
  const ctx = await clientCtx(f.aUser);
  const verdict = (signature: string): AntivirusScanner => ({
    scan: async (stream) => {
      await stream.pipeTo(new WritableStream());
      return { clean: false, signature };
    },
  });
  const ids: string[] = [];
  for (const signature of ['Heuristics.Encrypted.Zip', 'Heuristics.Limits.Exceeded.MaxFiles']) {
    setScannerForTests(verdict(signature));
    const id = await upload(f.aUser, 'архив.zip', 'application/zip', ZIP);
    ids.push(id);
    expect(await scanAttachment(SYSTEM, id), signature).toBe('rejected');
    expect(await row(id)).toMatchObject({ scan_status: 'rejected', scan_signature: signature, storage_key: `quarantine/${id}` });
    expect(storage.has(`quarantine/${id}`)).toBe(false);
  }
  // Документ Office с паролем лежит в контейнере OLE: до антивируса не доходит, причина та же.
  setScannerForTests(counting(createStubScanner()));
  const office = await upload(f.aUser, 'отчёт с паролем.xlsx', '', OLE);
  ids.push(office);
  expect(await scanAttachment(SYSTEM, office)).toBe('rejected');
  expect(await row(office)).toMatchObject({ scan_status: 'rejected', scan_signature: 'encrypted_office', detected_type: 'ole' });
  expect(scans).toBe(0);
  // Это не заражение: в журнале аудита записей о заражении нет.
  const audit = await pools.root.query(`select 1 from hdc_audit_log where action = 'attachment.infected' and object_id = any($1::text[])`, [ids]);
  expect(audit.rows).toEqual([]);
  // На странице обращения видна причина: что сделать клиенту.
  const fresh = await upload(f.aUser, 'ещё архив.zip', 'application/zip', ZIP);
  const created = await createTicket(ctx, { description: 'Архив с паролем', type: 'bug', impact: 'minor', locale: 'ru', attachmentIds: [fresh] });
  setScannerForTests(verdict('Heuristics.Encrypted.Zip'));
  expect(await scanAttachment(SYSTEM, fresh)).toBe('rejected');
  const view = await getTicket(ctx, String(created.number));
  expect(view?.attachments.map((a) => ({ scanStatus: a.scanStatus, rejectReason: a.rejectReason }))).toEqual([{ scanStatus: 'rejected', rejectReason: 'encrypted' }]);
});
