import { afterEach, beforeEach, expect, test } from 'vitest';
import { MemoryJobQueue, MemoryStorage, setJobQueueForTests, setStorageForTests } from '@/modules/hdc/testing';
import { sweepIdeaUploads } from '@/modules/hdi/api/uploads';
import { ideaQuarantineKey } from '@/modules/hdi/pref';
import { sweepSolutionFiles } from '@/modules/hdk/api/files';
import { fileQuarantineKey } from '@/modules/hdk/pref';
import { pools, system } from './helpers/db';
import { type Fixture, seedTwoOrgs } from './isolation/fixture';

// Обход зависших проверок файлов решений и идей (проверка качества, Q5), по образцу вложений обращений
// (sweepAttachments): постановка проверки после "загрузка завершена" могла не пройти или исчерпать повторы, и файл
// навсегда оставался "проверяется". Файл pending старше двух минут ставится снова, старше суток не принимается.

let f: Fixture;
let jobs: MemoryJobQueue;
let storage: MemoryStorage;
let articleId: string;

beforeEach(async () => {
  f = await seedTwoOrgs();
  jobs = new MemoryJobQueue();
  setJobQueueForTests(jobs);
  storage = new MemoryStorage();
  setStorageForTests(storage);
  articleId = (await pools.root.query(`insert into hdk_articles (audience, original_locale) values ('clients', 'ru') returning article_id`)).rows[0].article_id;
});
afterEach(() => {
  setJobQueueForTests(null);
  setStorageForTests(null);
});

const later = (minutes: number) => new Date(Date.now() + minutes * 60_000);
const png = new Uint8Array([137, 80, 78, 71]);

async function kbFile(): Promise<string> {
  const id = (await pools.root.query(`insert into hdk_article_files (article_id, storage_key, file_name, mime, size) values ($1, 'quarantine/kb/' || uuidv7(), 'a.png', 'image/png', 4) returning file_id`, [articleId])).rows[0].file_id as string;
  return id;
}
async function ideaFile(): Promise<string> {
  return (
    await pools.root.query(`insert into hdi_attachments (org_id, uploader_id, storage_key, file_name, mime, size) values ($1, $2, 'quarantine/ideas/' || uuidv7(), 'a.png', 'image/png', 4) returning attachment_id`, [f.orgA.orgId, f.aUser.userId])
  ).rows[0].attachment_id as string;
}
const sent = (name: string) => jobs.sent.filter((j) => j.name === name).map((j) => j.data);

test('файл решения: свежий не трогается, загруженный ставится на проверку через 2 минуты, брошенный через час, зависший на сутки не принимается', async () => {
  const uploaded = await kbFile();
  const abandoned = await kbFile();
  await storage.put(fileQuarantineKey(uploaded), png, 'image/png');
  expect(await sweepSolutionFiles(system, later(1))).toEqual({ requeued: 0, failed: 0 });
  // Файл в карантине есть: проверка ставится снова. Файла нет: браузер, возможно, ещё грузит его, ждём час.
  expect(await sweepSolutionFiles(system, later(3))).toEqual({ requeued: 1, failed: 0 });
  expect(sent('kb.scan')).toEqual([{ fileId: uploaded }]);
  jobs.sent.length = 0;
  expect(await sweepSolutionFiles(system, later(61))).toEqual({ requeued: 2, failed: 0 });
  expect(sent('kb.scan')).toHaveLength(2);
  // Сутки без итога: файл не принят, карантин очищен, больше не ставится.
  jobs.sent.length = 0;
  expect(await sweepSolutionFiles(system, later(24 * 60 + 1))).toEqual({ requeued: 0, failed: 2 });
  expect((await pools.root.query(`select scan_status from hdk_article_files where file_id = any($1)`, [[uploaded, abandoned]])).rows.map((r) => r.scan_status)).toEqual(['rejected', 'rejected']);
  expect(await storage.head(fileQuarantineKey(uploaded))).toBeNull();
  expect(sent('kb.scan')).toEqual([]);
});

test('изображение идеи: то же правило обхода', async () => {
  const uploaded = await ideaFile();
  await storage.put(ideaQuarantineKey(uploaded), png, 'image/png');
  expect(await sweepIdeaUploads(system, later(1))).toEqual({ requeued: 0, failed: 0 });
  expect(await sweepIdeaUploads(system, later(3))).toEqual({ requeued: 1, failed: 0 });
  expect(sent('ideas.scan')).toEqual([{ attachmentId: uploaded }]);
  expect(await sweepIdeaUploads(system, later(24 * 60 + 1))).toEqual({ requeued: 0, failed: 1 });
  expect((await pools.root.query(`select scan_status from hdi_attachments where attachment_id = $1`, [uploaded])).rows[0].scan_status).toBe('rejected');
  expect(await storage.head(ideaQuarantineKey(uploaded))).toBeNull();
});

test('проверенные файлы обход не трогает', async () => {
  const clean = await kbFile();
  await pools.root.query(`update hdk_article_files set scan_status = 'clean' where file_id = $1`, [clean]);
  expect(await sweepSolutionFiles(system, later(24 * 60 + 1))).toEqual({ requeued: 0, failed: 0 });
});
