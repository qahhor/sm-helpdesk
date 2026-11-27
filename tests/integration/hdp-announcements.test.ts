import { afterEach, beforeEach, expect, test } from 'vitest';
import { setAiClientForTests, StubAiClient } from '@/modules/hda/testing';
import { MemoryJobQueue, setJobQueueForTests } from '@/modules/hdc/testing';
import {
  activeAnnouncements,
  activeOutage,
  announcementArchive,
  dismissAnnouncement,
  endAnnouncement,
  listStaffAnnouncements,
  requestAnnouncementTranslation,
  saveAnnouncement,
  saveAnnouncementTranslation,
} from '@/modules/hdp/api/announcements';
import { runAnnouncementTranslationJob } from '@/modules/hdp/api/translate-jobs';
import { clientCtx, staffCtx, staffWithRole } from './helpers/auth';
import { asActor, pools, system } from './helpers/db';
import { type Fixture, SEALED, seedTwoOrgs } from './isolation/fixture';

// Объявления (ТЗ 7.18, FR-ANN-01, 02, 04, FR-ADM-12; план M5c, задача 6, решение 24): пишут care и admin с журналом
// аудита; клиент видит действующие объявления своей аудитории, архив за 90 суток, закрытый баннер больше не видит.

let f: Fixture;
let care: ReturnType<typeof staffCtx>;
let jobs: MemoryJobQueue;
let moduleId: string;
let otherServer: string;

beforeEach(async () => {
  f = await seedTwoOrgs();
  care = staffCtx(f.care);
  jobs = new MemoryJobQueue();
  setJobQueueForTests(jobs);
  setAiClientForTests(new StubAiClient());
  moduleId = (await pools.root.query(`insert into hdr_product_modules (code, name) values ('warehouse', '{"ru": "Склад"}') returning module_id`)).rows[0].module_id;
  otherServer = (
    await pools.root.query(`insert into hdu_servers (name, base_url, issuer, oauth_client_id, oauth_client_secret, code) values ('Другой', 'https://other.smartup.example', 'https://other.smartup.example', 'hub', $1, 'other') returning server_id`, [SEALED])
  ).rows[0].server_id;
});
afterEach(() => {
  setJobQueueForTests(null);
  setAiClientForTests();
});

const HOUR = 3_600_000;
const iso = (offsetMs: number) => new Date(Date.now() + offsetMs).toISOString();

async function announce(patch: Record<string, unknown> = {}): Promise<string> {
  const { announcementId } = await saveAnnouncement(care, {
    kind: 'maintenance',
    audience: 'all',
    startsOn: iso(-HOUR),
    endsOn: iso(24 * HOUR),
    locale: 'ru',
    title: 'Плановые работы',
    body: 'Ночью портал будет недоступен 30 минут.',
    ...patch,
  });
  return announcementId;
}

const seen = async (member = f.aUser, opts: { surface?: 'portal' | 'form' | 'widget'; moduleId?: string } = {}) =>
  (await activeAnnouncements((await clientCtx(member)).actor, { locale: 'ru', surface: opts.surface ?? 'portal', ...(opts.moduleId ? { moduleId: opts.moduleId } : {}) })).map((a) => a.title);

test('клиент видит действующее объявление своей аудитории; чужой сервер, не начавшееся и закончившееся не видит', async () => {
  await announce({ title: 'Для всех' });
  await announce({ title: 'Свой сервер', audience: 'server', serverId: f.server.serverId });
  await announce({ title: 'Чужой сервер', audience: 'server', serverId: otherServer });
  await announce({ title: 'Позже', startsOn: iso(HOUR), endsOn: iso(5 * HOUR) });
  const ended = await announce({ title: 'Закончилось' });
  await endAnnouncement(care, { announcementId: ended });
  expect((await seen()).sort()).toEqual(['Для всех', 'Свой сервер']);
  // Архив: закончившиеся за 90 суток и действующие, без чужого сервера и не начавшихся.
  expect((await announcementArchive(await clientCtx(f.aUser), { locale: 'ru' })).map((a) => a.title).sort()).toEqual(['Для всех', 'Закончилось', 'Свой сервер']);
  // Напрямую в базу клиент не читает ни чужого сервера, ни не начавшегося.
  const direct = await asActor(pools.app, f.bUser.actor, (c) => c.query(`select a.announcement_id from hdp_announcements a join hdp_announcement_translations t using (announcement_id) where t.title in ('Чужой сервер', 'Позже')`));
  expect(direct.rows).toEqual([]);
});

test('аудитория "модуль": на главной у всех, над формой и в виджете только при этом модуле', async () => {
  await announce({ title: 'Сбой склада', kind: 'outage', audience: 'module', moduleId });
  expect(await seen(f.aUser, { surface: 'portal' })).toEqual(['Сбой склада']);
  expect(await seen(f.aUser, { surface: 'form' })).toEqual([]);
  expect(await seen(f.aUser, { surface: 'widget', moduleId })).toEqual(['Сбой склада']);
  const other = (await pools.root.query(`insert into hdr_product_modules (code, name) values ('orders', '{"ru": "Заказы"}') returning module_id`)).rows[0].module_id;
  expect(await seen(f.aUser, { surface: 'form', moduleId: other })).toEqual([]);
  // Сбой для помощника (задача 7): своего модуля или для всех.
  const org = f.orgA.orgId;
  expect(await activeOutage(system, { orgId: org, moduleId })).toMatchObject({ announcementId: expect.any(String) });
  expect(await activeOutage(system, { orgId: org, moduleId: other })).toBeNull();
  expect(await activeOutage(system, { orgId: org, moduleId: null })).toBeNull();
});

test('закрытый баннер не показывается тому, кто закрыл, у коллеги показывается; чужие закрытия клиент не читает', async () => {
  const id = await announce({ title: 'Новость', kind: 'news' });
  await dismissAnnouncement(await clientCtx(f.aUser), { announcementId: id });
  await dismissAnnouncement(await clientCtx(f.aUser), { announcementId: id });
  expect(await seen(f.aUser)).toEqual([]);
  expect(await seen(f.aUser, { surface: 'widget' })).toEqual([]);
  expect(await seen(f.aAdmin)).toEqual(['Новость']);
  expect((await asActor(pools.app, f.aAdmin.actor, (c) => c.query(`select 1 from hdp_announcement_dismissals`))).rows).toEqual([]);
  // Закрыть объявление другого сервера нельзя: его клиент не видит.
  const foreign = await announce({ title: 'Чужой', audience: 'server', serverId: otherServer });
  await expect(dismissAnnouncement(await clientCtx(f.aUser), { announcementId: foreign })).rejects.toMatchObject({ code: 'not_found' });
});

test('пишут только care и admin с журналом аудита; период длиннее 90 суток и конец раньше начала отклоняются', async () => {
  for (const ctx of [staffCtx(f.l1), staffCtx(await staffWithRole('agent_l2')), staffCtx(await staffWithRole('product'))])
    await expect(saveAnnouncement(ctx, { kind: 'news', audience: 'all', startsOn: iso(0), endsOn: iso(HOUR), locale: 'ru', title: 'Новость', body: '' })).rejects.toMatchObject({ code: 'forbidden' });
  await expect(announce({ endsOn: iso(91 * 24 * HOUR) })).rejects.toMatchObject({ code: 'invalid_input' });
  await expect(announce({ startsOn: iso(HOUR), endsOn: iso(0) })).rejects.toMatchObject({ code: 'invalid_input' });
  await expect(announce({ audience: 'server' })).rejects.toMatchObject({ code: 'invalid_input' });
  await expect(announce({ body: 'Звоните +998 90 123-45-67' })).rejects.toMatchObject({ code: 'text_findings' });
  const id = await announce();
  await saveAnnouncement(staffCtx(f.adminStaff), { announcementId: id, kind: 'maintenance', audience: 'all', startsOn: iso(-HOUR), endsOn: iso(2 * HOUR), locale: 'ru', title: 'Работы перенесены', body: 'Ночью.' });
  await endAnnouncement(care, { announcementId: id });
  expect((await pools.root.query(`select action from hdc_audit_log where action like 'announcement.%' order by created_on, audit_id`)).rows.map((r) => r.action)).toEqual([
    'announcement.saved',
    'announcement.saved',
    'announcement.ended',
  ]);
  expect((await listStaffAnnouncements(care)).map((a) => a.state)).toEqual(['ended']);
});

test('машинный перевод клиенту не виден до принятия', async () => {
  const id = await announce({ title: 'Работы' });
  await requestAnnouncementTranslation(care, { announcementId: id, locale: 'en' });
  const job = jobs.sent.find((j) => j.name === 'announcements.translate');
  expect(job?.data).toEqual({ announcementId: id, locale: 'en' });
  await runAnnouncementTranslationJob(system, job!.data);
  expect((await pools.root.query(`select purpose from hda_runs`)).rows).toEqual([{ purpose: 'announcement_translation' }]);
  const english = async () => (await activeAnnouncements((await clientCtx(f.aUser)).actor, { locale: 'en', surface: 'portal' })).map((a) => a.locale);
  expect(await english()).toEqual(['ru']);
  await saveAnnouncementTranslation(care, { announcementId: id, locale: 'en', title: 'Работы', body: 'Ночью портал будет недоступен 30 минут.', acceptMachine: true });
  expect(await english()).toEqual(['en']);
});
