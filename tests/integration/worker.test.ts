import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { PgBoss } from 'pg-boss';
import { bossOptions, createPgBossQueue, JOB_NAMES } from '@/modules/hdc/api';
import { MemoryJobQueue, MemoryStorage, setJobQueueForTests, setScannerForTests, setStorageForTests } from '@/modules/hdc/testing';
import { createStubScanner } from '@/modules/hdc/antivirus/stub';
import { completeUpload, createTicket, presignUpload, SWEEP_BATCH, sweepAttachments } from '@/modules/hdt/api';
import { SCHEDULES, startWorker } from '@/worker/main';
import { QUEUES } from '../../scripts/db/pgboss.mjs';
import { clientCtx } from './helpers/auth';
import { appUrl, pools } from './helpers/db';
import { seedTwoOrgs } from './isolation/fixture';

// Фоновый процесс на pg-boss (раздел 11.10, решение 0028; план M2, задача 7).

let storage: MemoryStorage;
beforeEach(async () => {
  // Таблицы pg-boss не предметные: общая очистка их не трогает, задачи прошлых тестов убираются здесь.
  await pools.owner.query('delete from pgboss.job');
  storage = new MemoryStorage();
  setStorageForTests(storage);
  setScannerForTests(createStubScanner());
});
afterEach(() => {
  setStorageForTests(null);
  setScannerForTests(null);
  setJobQueueForTests(null);
});

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...new Array(24).fill(1)]);
const statusOf = (id: string) => pools.root.query(`select scan_status from hdt_attachments where attachment_id = $1`, [id]).then((r) => r.rows[0]?.scan_status as string | undefined);

/** Сдвигает время создания вложения в прошлое: служебные колонки защищены триггером, поэтому без триггеров. */
async function age(id: string, interval: string): Promise<void> {
  const client = await pools.root.connect();
  try {
    await client.query('begin');
    await client.query('set local session_replication_role = replica');
    await client.query(`update hdt_attachments set created_on = now() - $2::interval where attachment_id = $1`, [id, interval]);
    await client.query('commit');
  } finally {
    client.release();
  }
}

async function waitFor(check: () => Promise<boolean>, timeoutMs = 15_000): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > until) throw new Error('не дождались');
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

test('migrate ставит схему pgboss от hub_owner, hub_app ставит и берёт задачи, но не создаёт схемы', async () => {
  expect((await pools.root.query(`select nspowner::regrole::text as owner from pg_namespace where nspname = 'pgboss'`)).rows).toEqual([{ owner: 'hub_owner' }]);
  expect((await pools.root.query(`select distinct tableowner from pg_tables where schemaname = 'pgboss'`)).rows).toEqual([{ tableowner: 'hub_owner' }]);
  await expect(pools.app.query('create schema intruder')).rejects.toThrow(/permission denied/);
  await expect(pools.app.query('create table pgboss.intruder (id int)')).rejects.toThrow(/permission denied/);
  // Очереди создал скрипт миграций, их состав совпадает с перечнем портала.
  expect(Object.keys(QUEUES).sort()).toEqual([...JOB_NAMES].sort());
  const boss = new PgBoss(bossOptions(appUrl, 'sender'));
  boss.on('error', () => {});
  await boss.start();
  try {
    expect((await boss.getQueues()).map((q) => q.name).sort()).toEqual([...JOB_NAMES].sort());
    expect(await boss.getQueue('attachment.scan')).toMatchObject({ policy: 'exclusive', retryLimit: 5 });
    const queue = createPgBossQueue(boss);
    const attachmentId = '0192d2a4-0000-7000-8000-000000000001';
    // Вторая задача для того же файла, пока первая не выполнена, не ставится.
    await queue.send('attachment.scan', { attachmentId });
    await queue.send('attachment.scan', { attachmentId });
    const jobs = await boss.fetch('attachment.scan', { batchSize: 10 });
    expect(jobs.map((job) => job.data)).toEqual([{ attachmentId }]);
    await boss.complete('attachment.scan', jobs.map((job) => job.id));
  } finally {
    await boss.stop({ graceful: false });
  }
});

test('задача проверки доходит до scanAttachment и не содержит ничего, кроме идентификатора', async () => {
  const f = await seedTwoOrgs();
  const worker = await startWorker({ connectionString: appUrl, pollingIntervalSeconds: 0.5, schedules: false });
  try {
    const ctx = await clientCtx(f.aUser);
    const { attachmentId } = await presignUpload(ctx, { fileName: 'Секретный отчёт клиента.png', size: PNG.byteLength, mime: 'image/png' });
    storage.put(`quarantine/${attachmentId}`, PNG);
    expect(await completeUpload(ctx, attachmentId)).toEqual({ status: 'pending' });
    await waitFor(async () => (await statusOf(attachmentId)) === 'clean');
    const stored = await pools.root.query(`select data from pgboss.job where name = 'attachment.scan'`);
    expect(stored.rows).toEqual([{ data: { attachmentId } }]);
  } finally {
    await worker.stop();
  }
});

test('задача обращений раз в минуту в расписании и выполняется фоновым процессом (план M3, задача 13)', async () => {
  expect(SCHEDULES).toContainEqual({ name: 'tickets.minute', cron: '* * * * *', tz: 'UTC' });
  const f = await seedTwoOrgs();
  await pools.root.query(`insert into hdt_ticket_presence (ticket_id, user_id, mode, expires_on) values ($1, $2, 'viewing', now() - interval '1 minute')`, [
    f.tickets.aOrg.ticketId,
    f.l1.userId,
  ]);
  const worker = await startWorker({ connectionString: appUrl, pollingIntervalSeconds: 0.5, schedules: false });
  try {
    const boss = new PgBoss(bossOptions(appUrl, 'sender'));
    boss.on('error', () => {});
    await boss.start();
    try {
      await createPgBossQueue(boss).send('tickets.minute', {});
    } finally {
      await boss.stop({ graceful: false });
    }
    await waitFor(async () => (await pools.root.query(`select count(*)::int as n from hdt_ticket_presence`)).rows[0].n === 0);
  } finally {
    await worker.stop();
  }
});

test('очереди ещё нет (процесс стартовал раньше миграций): процесс ждёт её, а не падает', async () => {
  const owner = new PgBoss({ connectionString: process.env.DATABASE_URL_OWNER, schema: 'pgboss', supervise: false, schedule: false, migrate: false });
  owner.on('error', () => {});
  await owner.start();
  try {
    await owner.deleteQueue('tickets.minute');
    const starting = startWorker({ connectionString: appUrl, pollingIntervalSeconds: 0.5, startAttempts: 5 });
    await new Promise((resolve) => setTimeout(resolve, 1500));
    await owner.createQueue('tickets.minute', QUEUES['tickets.minute']);
    const worker = await starting;
    await worker.stop();
  } finally {
    if (!(await owner.getQueue('tickets.minute'))) await owner.createQueue('tickets.minute', QUEUES['tickets.minute']);
    await owner.stop({ graceful: false });
  }
});

test('файл pending старше двух минут без задачи снова ставится на проверку (на что смотреть, 2)', async () => {
  const f = await seedTwoOrgs();
  const jobs = new MemoryJobQueue();
  setJobQueueForTests(jobs);
  const ctx = await clientCtx(f.aUser);
  const presign = async (withObject: boolean) => {
    const { attachmentId } = await presignUpload(ctx, { fileName: 'shot.png', size: PNG.byteLength, mime: 'image/png' });
    if (withObject) storage.put(`quarantine/${attachmentId}`, PNG);
    return attachmentId;
  };
  const stale = await presign(true);
  await age(stale, '3 minutes');
  const fresh = await presign(true);
  await age(fresh, '1 minute');
  // Файла ещё нет: браузер, возможно, продолжает загрузку. Через час ссылка точно не загрузит ничего.
  const uploading = await presign(false);
  await age(uploading, '3 minutes');
  const abandoned = await presign(false);
  await age(abandoned, '2 hours');
  const result = await sweepAttachments({ type: 'system', job: 'attachment.sweep' });
  expect(result.requeued).toBe(2);
  expect(jobs.sent.map((job) => job.data.attachmentId).sort()).toEqual([stale, abandoned].sort());
  expect(jobs.sent.every((job) => job.name === 'attachment.scan' && Object.keys(job.data).length === 1)).toBe(true);
});

test('проверка, которая не проходит больше суток, заканчивается: rejected с отметкой scan_failed, файл удалён', async () => {
  const f = await seedTwoOrgs();
  const jobs = new MemoryJobQueue();
  setJobQueueForTests(jobs);
  const ctx = await clientCtx(f.aUser);
  const { attachmentId } = await presignUpload(ctx, { fileName: 'archive.zip', size: PNG.byteLength, mime: 'application/zip' });
  storage.put(`quarantine/${attachmentId}`, PNG);
  // Файл уже прикреплён к обращению: обход загрузок его не удалит, а проверка всё время срывается.
  await createTicket(ctx, { description: 'С архивом', type: 'bug', impact: 'minor', locale: 'ru', attachmentIds: [attachmentId] });
  await age(attachmentId, '25 hours');
  const errors: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => void errors.push(args.join(' '));
  try {
    const result = await sweepAttachments({ type: 'system', job: 'attachment.sweep' });
    expect(result.failed).toBe(1);
  } finally {
    console.error = original;
  }
  const [row] = (await pools.root.query(`select scan_status, scan_signature from hdt_attachments where attachment_id = $1`, [attachmentId])).rows;
  expect(row).toEqual({ scan_status: 'rejected', scan_signature: 'scan_failed' });
  expect(storage.has(`quarantine/${attachmentId}`)).toBe(false);
  expect(jobs.sent).toEqual([]);
  // В журнале процесса идентификатор, без имени файла: по нему оператор находит зависшую проверку.
  expect(errors.join('\n')).toContain(attachmentId);
  expect(errors.join('\n')).not.toContain('archive.zip');
});

test('зависших проверок много: обход берёт их пачками, а не все одной транзакцией (вторая проверка M2)', async () => {
  const f = await seedTwoOrgs();
  setJobQueueForTests(new MemoryJobQueue());
  // Антивирус лежал несколько дней: зависших файлов больше, чем берёт один проход.
  const client = await pools.root.connect();
  try {
    await client.query('begin');
    await client.query('set local session_replication_role = replica');
    await client.query(
      `insert into hdt_attachments (attachment_id, org_id, ticket_id, uploader_id, storage_key, file_name, mime, size, created_on)
       select id, $1, $2, $3, 'quarantine/' || id, 'a.png', 'image/png', 10, now() - interval '25 hours'
         from (select uuidv7() as id from generate_series(1, $4::int)) as generated`,
      [f.orgA.orgId, f.tickets.aOrg.ticketId, f.aUser.userId, SWEEP_BATCH + 1],
    );
    await client.query('commit');
  } finally {
    client.release();
  }
  const original = console.error;
  console.error = () => {};
  try {
    expect((await sweepAttachments({ type: 'system', job: 'attachment.sweep' })).failed).toBe(SWEEP_BATCH);
    expect((await sweepAttachments({ type: 'system', job: 'attachment.sweep' })).failed).toBe(1);
  } finally {
    console.error = original;
  }
  const left = await pools.root.query(
    `select count(*)::int as n from hdt_attachments where scan_status = 'pending' and ticket_id = $1 and created_on < now() - interval '1 day'`,
    [f.tickets.aOrg.ticketId],
  );
  expect(left.rows[0].n).toBe(0);
});

test('неприкреплённая загрузка старше суток удаляется вместе с объектом в хранилище', async () => {
  const f = await seedTwoOrgs();
  setJobQueueForTests(new MemoryJobQueue());
  const ctx = await clientCtx(f.aUser);
  const upload = async () => {
    const { attachmentId } = await presignUpload(ctx, { fileName: 'shot.png', size: PNG.byteLength, mime: 'image/png' });
    storage.put(`quarantine/${attachmentId}`, PNG);
    return attachmentId;
  };
  const old = await upload();
  const recent = await upload();
  const attached = await upload();
  await createTicket(ctx, { description: 'С файлом', type: 'bug', impact: 'minor', locale: 'ru', attachmentIds: [attached] });
  // Проверенный неприкреплённый файл лежит уже в папке организации.
  const cleanOld = await upload();
  await storage.move(`quarantine/${cleanOld}`, `files/${f.orgA.orgId}/${cleanOld}`, { contentType: 'image/png' });
  await pools.root.query(`update hdt_attachments set scan_status = 'clean', storage_key = $2 where attachment_id = $1`, [cleanOld, `files/${f.orgA.orgId}/${cleanOld}`]);
  for (const id of [old, attached, cleanOld]) await age(id, '25 hours');
  await age(recent, '23 hours');
  const result = await sweepAttachments({ type: 'system', job: 'attachment.sweep' });
  expect(result.removed).toBe(2);
  expect(await statusOf(old)).toBeUndefined();
  expect(await statusOf(cleanOld)).toBeUndefined();
  expect(storage.has(`quarantine/${old}`)).toBe(false);
  expect(storage.has(`files/${f.orgA.orgId}/${cleanOld}`)).toBe(false);
  expect(await statusOf(recent)).toBe('pending');
  // Прикреплённый файл не удаляется, но его проверка не прошла за сутки: он не принят.
  expect(await statusOf(attached)).toBe('rejected');
  expect(storage.has(`quarantine/${recent}`)).toBe(true);
});

test('собранный worker.mjs запускается без каталога node_modules и останавливается по SIGTERM', async () => {
  execFileSync(process.execPath, ['scripts/build-cli.mjs'], { stdio: 'pipe' });
  const dir = mkdtempSync(join(tmpdir(), 'hub-worker-'));
  cpSync('dist/worker.mjs', join(dir, 'worker.mjs'));
  // Без окружения процесс не стартует и называет причину.
  const refused = spawnSync(process.execPath, ['worker.mjs'], { cwd: dir, env: { PATH: process.env.PATH ?? '' } as unknown as NodeJS.ProcessEnv, encoding: 'utf8' });
  expect(refused.status).toBe(1);
  expect(refused.stderr).toMatch(/Фоновый процесс не запущен: Неверные переменные окружения/);
  const child = spawn(process.execPath, ['worker.mjs'], { cwd: dir, env: { ...process.env, FILE_STORAGE_DIR: join(dir, 'storage') } });
  let output = '';
  child.stdout.on('data', (piece) => (output += String(piece)));
  child.stderr.on('data', (piece) => (output += String(piece)));
  const exited = new Promise<number | null>((resolve) => child.on('exit', resolve));
  await waitFor(async () => output.includes('Фоновый процесс запущен'), 30_000);
  // Расписания записаны в pg-boss.
  expect((await pools.root.query(`select name, cron, timezone from pgboss.schedule order by name`)).rows).toEqual([
    { name: 'attachment.sweep', cron: '* * * * *', timezone: 'UTC' },
    { name: 'maintenance.cleanup', cron: '0 3 * * *', timezone: 'Asia/Tashkent' },
    { name: 'tickets.minute', cron: '* * * * *', timezone: 'UTC' },
  ]);
  child.kill('SIGTERM');
  expect(await exited).toBe(0);
  expect(output).not.toMatch(/permission denied|Фоновый процесс: /);
}, 120_000);
