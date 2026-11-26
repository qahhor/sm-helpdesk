import { afterEach, beforeEach, expect, test } from 'vitest';
import { completeIdeaUpload, presignIdeaUpload } from '@/modules/hdi/api/uploads';
import { scanIdeaAttachment } from '@/modules/hdi/api/jobs';
import { editOwnIdea, setIdeaShowOrg, submitIdea } from '@/modules/hdi/api/submit';
import { MemoryJobQueue, MemoryStorage, setJobQueueForTests, setStorageForTests } from '@/modules/hdc/testing';
import { clientCtx } from './helpers/auth';
import { asActor, pools, system } from './helpers/db';
import { seedTwoOrgs } from './isolation/fixture';

// Подача идеи (ТЗ FR-IDEA-01, 06, 14.5; план M7, задача 2, решения 4, 5, 7, 9, 10, 15).

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

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...new Array(56).fill(1)]);
const idea = (number: number) =>
  pools.root
    .query(
      `select i.idea_id, i.org_id, i.author_id, i.author_name, i.author_org_name, i.show_org, i.status, i.vote_count, i.original_locale,
              t.title, t.body, t.status as text_status, t.is_machine
         from hdi_ideas i join hdi_idea_translations t on t.idea_id = i.idea_id where i.number = $1`,
      [number],
    )
    .then((r) => r.rows[0]);
const base = { title: 'Печать накладных пачкой', body: 'Хотим печатать все накладные дня одной кнопкой', locale: 'ru' };

test('идея создаётся на модерации: автор и организация из актора, подставленные org_id и author_id игнорируются', async () => {
  const f = await seedTwoOrgs();
  const ctx = await clientCtx(f.aUser);
  const result = await submitIdea(ctx, { ...base, orgId: f.orgB.orgId, org_id: f.orgB.orgId, authorId: f.bUser.userId, author_id: f.bUser.userId, showOrg: true });
  expect(result.status).toBe('submitted');
  const number = (result as { number: number }).number;
  expect(await idea(number)).toMatchObject({
    org_id: f.orgA.orgId,
    author_id: f.aUser.userId,
    author_name: f.aUser.name,
    author_org_name: f.orgA.name,
    show_org: true,
    status: 'pending_review',
    original_locale: 'ru',
    title: base.title,
    text_status: 'original',
    is_machine: false,
  });
  const audit = await pools.root.query(`select diff from hdc_audit_log where action = 'idea.submitted' and org_id = $1`, [f.orgA.orgId]);
  expect(JSON.stringify(audit.rows)).not.toContain(base.title);
  // Невидимые знаки вырезаются, пустой заголовок и слишком длинный отклоняются.
  await expect(submitIdea(ctx, { ...base, title: '​ ⁠' })).rejects.toMatchObject({ code: 'invalid_input' });
  await expect(submitIdea(ctx, { ...base, title: 'x'.repeat(121) })).rejects.toMatchObject({ code: 'invalid_input' });
});

test('решение 4 и 15: голос автора и его подписка ставятся сами при подаче', async () => {
  const f = await seedTwoOrgs();
  const result = await submitIdea(await clientCtx(f.aUser), base);
  const row = await idea((result as { number: number }).number);
  expect(row.vote_count).toBe(1);
  expect((await pools.root.query(`select user_id from hdi_votes where idea_id = $1`, [row.idea_id])).rows).toEqual([{ user_id: f.aUser.userId }]);
  expect((await pools.root.query(`select user_id from hdi_subscriptions where idea_id = $1`, [row.idea_id])).rows).toEqual([{ user_id: f.aUser.userId }]);
});

test('решение 9: находки проверки текста возвращаются предупреждением, а не отказом; после подтверждения идея создаётся', async () => {
  const f = await seedTwoOrgs();
  const ctx = await clientCtx(f.aUser);
  const text = { ...base, body: 'Звоните +998 90 123 45 67 или пишите boss@acme.uz' };
  const warned = await submitIdea(ctx, text);
  expect(warned).toEqual({ status: 'confirm', findings: ['phone', 'email'] });
  expect((await pools.root.query(`select count(*)::int as n from hdi_ideas where author_id = $1`, [f.aUser.userId])).rows[0].n).toBe(0);
  const sent = await submitIdea(ctx, { ...text, confirmFindings: true });
  expect(sent.status).toBe('submitted');
});

test('14.5: шестая идея за сутки отклоняется', async () => {
  const f = await seedTwoOrgs();
  const ctx = await clientCtx(f.aAdmin);
  for (let i = 0; i < 5; i++) expect((await submitIdea(ctx, { ...base, title: `Идея ${i}` })).status).toBe('submitted');
  await expect(submitIdea(ctx, { ...base, title: 'Шестая' })).rejects.toMatchObject({ code: 'rate_limited' });
});

test('решение 5: автор правит идею на модерации, после публикации правка отклоняется; показ организации меняет всегда', async () => {
  const f = await seedTwoOrgs();
  const ctx = await clientCtx(f.aUser);
  const { number } = (await submitIdea(ctx, base)) as { number: number };
  await editOwnIdea(ctx, { number: `I-${number}`, title: 'Печать накладных пачкой за день', body: base.body, moduleId: '', showOrg: false });
  expect(await idea(number)).toMatchObject({ title: 'Печать накладных пачкой за день', show_org: false, author_org_name: null });
  // Чужую идею не правит: не находит.
  await expect(editOwnIdea(await clientCtx(f.aAdmin), { number, title: 'Чужая', body: 'x', showOrg: false })).rejects.toMatchObject({ code: 'not_found' });
  await pools.root.query(`update hdi_ideas set status = 'open' where number = $1`, [number]);
  await expect(editOwnIdea(ctx, { number, title: 'После публикации', body: 'x', showOrg: false })).rejects.toMatchObject({ code: 'not_editable' });
  await setIdeaShowOrg(ctx, { number, showOrg: true });
  expect(await idea(number)).toMatchObject({ show_org: true, author_org_name: f.orgA.name, title: 'Печать накладных пачкой за день' });
});

test('решение 10: SVG и файл больше 5 МБ отклоняются, изображение до проверки антивирусом чужим не видно', async () => {
  const f = await seedTwoOrgs();
  const ctx = await clientCtx(f.aUser);
  await expect(presignIdeaUpload(ctx, { purpose: 'idea', fileName: 'logo.svg', size: 100, mime: 'image/svg+xml' })).rejects.toMatchObject({ code: 'file_not_allowed' });
  await expect(presignIdeaUpload(ctx, { purpose: 'idea', fileName: 'shot.png', size: 100, mime: 'image/svg+xml' })).rejects.toMatchObject({ code: 'file_not_allowed' });
  await expect(presignIdeaUpload(ctx, { purpose: 'idea', fileName: 'big.png', size: 5 * 1024 * 1024 + 1, mime: 'image/png' })).rejects.toMatchObject({ code: 'file_too_large' });
  const { attachmentId, url } = await presignIdeaUpload(ctx, { purpose: 'idea', fileName: 'shot.png', size: PNG.byteLength, mime: 'image/png' });
  expect(url).toContain(`quarantine/ideas/${attachmentId}`);
  await storage.put(`quarantine/ideas/${attachmentId}`, PNG, 'image/png');
  expect(await completeIdeaUpload(ctx, { purpose: 'idea', attachmentId })).toEqual({ status: 'pending' });
  expect(jobs.sent).toContainEqual({ name: 'ideas.scan', data: { attachmentId } });
  const { number } = (await submitIdea(ctx, { ...base, attachmentIds: [attachmentId] })) as { number: number };
  const ideaId = (await idea(number)).idea_id as string;
  await pools.root.query(`update hdi_ideas set status = 'open' where idea_id = $1`, [ideaId]);
  const seenByB = () => asActor(pools.app, f.bUser.actor, (c) => c.query(`select attachment_id from hdi_attachments where idea_id = $1`, [ideaId])).then((r) => r.rows);
  expect(await seenByB()).toEqual([]);
  expect(await scanIdeaAttachment(system, { attachmentId })).toBe('clean');
  expect(await storage.head(`files/ideas/${f.orgA.orgId}/${attachmentId}`)).toEqual({ size: PNG.byteLength });
  expect(await seenByB()).toEqual([{ attachment_id: attachmentId }]);
  // Подделка под PNG отклоняется проверкой типа; чужую загрузку к своей идее не прикрепить.
  const fake = await presignIdeaUpload(ctx, { purpose: 'idea', fileName: 'x.png', size: 20, mime: 'image/png' });
  await storage.put(`quarantine/ideas/${fake.attachmentId}`, new TextEncoder().encode('<html><body>x</body>'), 'image/png');
  expect(await scanIdeaAttachment(system, { attachmentId: fake.attachmentId })).toBe('rejected');
  const other = await presignIdeaUpload(await clientCtx(f.aAdmin), { purpose: 'idea', fileName: 'y.png', size: 20, mime: 'image/png' });
  await expect(submitIdea(ctx, { ...base, attachmentIds: [other.attachmentId] })).rejects.toMatchObject({ code: 'not_found' });
});
