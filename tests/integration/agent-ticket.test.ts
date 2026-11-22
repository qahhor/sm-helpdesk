import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { MemoryStorage, setStorageForTests } from '@/modules/hdc/testing';
import { attachmentRedirect, getAgentTicket, markTicketRead, staffAttachmentRedirect } from '@/modules/hdt/api';
import { clientCtx, staffCtx, staffWithRole } from './helpers/auth';
import { pools } from './helpers/db';
import { seedTwoOrgs } from './isolation/fixture';

// Обращение у сотрудника (FR-AG-04, FR-AG-05, UX-A-14, UX-A-15, раздел 8.4; план M3, задача 6).

beforeEach(() => setStorageForTests(new MemoryStorage()));
afterEach(() => setStorageForTests(null));

/** Вложение в заданном состоянии проверки. */
async function file(f: Awaited<ReturnType<typeof seedTwoOrgs>>, opts: { name: string; mime: string; status: string; internal?: boolean }): Promise<string> {
  const id = randomUUID();
  await pools.root.query(
    `insert into hdt_attachments (attachment_id, org_id, ticket_id, uploader_id, storage_key, file_name, mime, size, scan_status, is_internal)
     values ($1, $2, $3, $4, $5, $6, $7, 10, $8, $9)`,
    [id, f.orgA.orgId, f.tickets.aOrg.ticketId, f.aUser.userId, opts.status === 'clean' ? `files/${f.orgA.orgId}/${id}` : `quarantine/${id}`, opts.name, opts.mime, opts.status, opts.internal ?? false],
  );
  return id;
}

test('сотрудник видит заметки, внутренние события и файлы всех состояний, скачивает только чистые', async () => {
  const f = await seedTwoOrgs();
  await pools.root.query(
    `insert into hdt_ticket_events (org_id, ticket_id, kind, actor_type, actor_id, payload, is_internal) values ($1, $2, 'priority', 'staff', $3, '{"from":"p2","to":"p1"}', true)`,
    [f.orgA.orgId, f.tickets.aOrg.ticketId, f.l1.userId],
  );
  const clean = await file(f, { name: 'shot.png', mime: 'image/png', status: 'clean' });
  const infected = await file(f, { name: 'virus.txt', mime: 'text/plain', status: 'infected' });
  const view = await getAgentTicket(staffCtx(f.l1), `SUP-${f.tickets.aOrg.number}`);
  expect(view).not.toBeNull();
  const messages = view?.timeline.filter((e) => e.type === 'message') ?? [];
  expect(messages.map((m) => (m.type === 'message' ? [m.body, m.isInternal] : null))).toEqual([
    ['Публичное сообщение', false],
    ['Внутренняя заметка', true],
  ]);
  expect(view?.timeline.some((e) => e.type === 'event' && e.kind === 'priority' && e.isInternal)).toBe(true);
  const files = view?.attachments.map((a) => [a.fileName, a.scanStatus]).sort();
  expect(files).toEqual(expect.arrayContaining([['shot.png', 'clean'], ['virus.txt', 'infected']]));
  const staff = staffCtx(f.l1);
  expect(await staffAttachmentRedirect(staff, clean, { inline: false })).toMatch(/^https:\/\/storage\.test\//);
  expect(await staffAttachmentRedirect(staff, infected, { inline: false })).toBeNull();
  // Обращение другой организации сотрудник тоже видит: у него полный доступ (5.3).
  expect(await getAgentTicket(staff, String(f.tickets.bPrivate.number))).not.toBeNull();
  expect(await getAgentTicket(staff, 'SUP-999999999')).toBeNull();
});

test('картинку и PDF сотрудник открывает в просмотре, клиент PDF скачивает', async () => {
  const f = await seedTwoOrgs();
  const pdf = await file(f, { name: 'отчёт.pdf', mime: 'application/pdf', status: 'clean' });
  const png = await file(f, { name: 'shot.png', mime: 'image/png', status: 'clean' });
  const disposition = (url: string | null) => new URL(url ?? 'https://x.test').searchParams.get('disposition') ?? '';
  const staff = staffCtx(f.l1);
  expect(disposition(await staffAttachmentRedirect(staff, pdf, { inline: true }))).toMatch(/^inline; /);
  expect(disposition(await staffAttachmentRedirect(staff, png, { inline: true }))).toMatch(/^inline; /);
  expect(disposition(await attachmentRedirect(await clientCtx(f.aUser), pdf, { inline: true }))).toMatch(/^attachment; /);
});

test('новое с прошлого визита отмечено, свой визит обновляет отметку', async () => {
  const f = await seedTwoOrgs();
  const staff = staffCtx(f.l1);
  const number = String(f.tickets.aOrg.number);
  expect((await getAgentTicket(staff, number))?.changedSince).toBeNull();
  await markTicketRead(staff, f.tickets.aOrg.ticketId);
  const seen = (await getAgentTicket(staff, number))?.changedSince;
  expect(seen).toBeInstanceOf(Date);
  // Отметка у каждого сотрудника своя.
  expect((await getAgentTicket(staffCtx(f.care), number))?.changedSince).toBeNull();
  // product тоже отмечает свои просмотры, хотя обращения не меняет.
  const product = await staffWithRole('product');
  await markTicketRead(staffCtx(product), f.tickets.aOrg.ticketId);
  expect((await getAgentTicket(staffCtx(product), number))?.changedSince).toBeInstanceOf(Date);
});

test('карточка клиента: организация, ИНН, сервер, категория, автор; исполнитель и линия', async () => {
  const f = await seedTwoOrgs();
  await pools.root.query(`update hdu_organizations set inn = '305001122', category = 'B' where org_id = $1`, [f.orgA.orgId]);
  await pools.root.query(`update auth."user" set email = 'alisher@acme.example', "emailVerified" = true where id = $1`, [f.aUser.userId]);
  await pools.root.query(`update hdt_tickets set assignee_id = $2, queue = 'l2' where ticket_id = $1`, [f.tickets.aOrg.ticketId, f.l1.userId]);
  const view = await getAgentTicket(staffCtx(f.care), String(f.tickets.aOrg.number));
  expect(view?.org).toEqual({ orgId: f.orgA.orgId, name: f.orgA.name, inn: '305001122', category: 'B', serverName: 'Облако' });
  expect(view?.author).toEqual({ id: f.aUser.userId, name: f.aUser.name, email: 'alisher@acme.example' });
  expect(view?.assignee).toEqual({ id: f.l1.userId, name: f.l1.name });
  expect(view?.line).toBe('l2');
});
