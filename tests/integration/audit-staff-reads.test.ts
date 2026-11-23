import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { MemoryStorage, setStorageForTests } from '@/modules/hdc/testing';
import { attachmentRedirect, getAgentTicket, getTicket, staffAttachmentRedirect } from '@/modules/hdt/api';
import { clientCtx, staffCtx } from './helpers/auth';
import { pools } from './helpers/db';
import { seedTwoOrgs } from './isolation/fixture';

// Чтение обращений и файлов сотрудниками в журнале аудита (аудит 23.11.2026, находка S8): массовое чтение чужих
// обращений оставляет след. Открытие обращения пишется не чаще раза в час на пару сотрудник и обращение.

beforeEach(() => setStorageForTests(new MemoryStorage()));
afterEach(() => setStorageForTests(null));

const rows = async (action: string) =>
  (await pools.root.query(`select actor_type, actor_id, object_type, object_id, org_id, diff from hdc_audit_log where action = $1 order by created_on`, [action])).rows;

test('открытие обращения сотрудником записано: кто, какое обращение, чья организация', async () => {
  const f = await seedTwoOrgs();
  expect(await getAgentTicket(staffCtx(f.l1), String(f.tickets.aOrg.number))).not.toBeNull();
  expect(await rows('ticket.viewed_by_staff')).toEqual([
    { actor_type: 'staff', actor_id: f.l1.userId, object_type: 'ticket', object_id: f.tickets.aOrg.ticketId, org_id: f.orgA.orgId, diff: { number: f.tickets.aOrg.number } },
  ]);
});

test('повторное открытие в течение часа записи не добавляет, через час добавляет, у другого сотрудника запись своя', async () => {
  const f = await seedTwoOrgs();
  const number = String(f.tickets.aOrg.number);
  await getAgentTicket(staffCtx(f.l1), number);
  await getAgentTicket(staffCtx(f.l1), number);
  expect(await rows('ticket.viewed_by_staff')).toHaveLength(1);
  await getAgentTicket(staffCtx(f.care), number);
  expect((await rows('ticket.viewed_by_staff')).map((row) => row.actor_id)).toEqual([f.l1.userId, f.care.userId]);
  await pools.root.query(`update hdt_ticket_reads set view_logged_on = now() - interval '61 minutes' where user_id = $1`, [f.l1.userId]);
  await getAgentTicket(staffCtx(f.l1), number);
  expect((await rows('ticket.viewed_by_staff')).map((row) => row.actor_id)).toEqual([f.l1.userId, f.care.userId, f.l1.userId]);
});

test('запись о чтении не трогает отметку "просмотрено": новое с прошлого визита считается по-прежнему', async () => {
  const f = await seedTwoOrgs();
  const number = String(f.tickets.aOrg.number);
  await getAgentTicket(staffCtx(f.l1), number);
  expect((await getAgentTicket(staffCtx(f.l1), number))?.changedSince).toBeNull();
});

test('несуществующее обращение и чтение клиентом своего обращения записи не оставляют', async () => {
  const f = await seedTwoOrgs();
  expect(await getAgentTicket(staffCtx(f.l1), 'SUP-999999999')).toBeNull();
  expect(await getTicket(await clientCtx(f.aUser), String(f.tickets.aOrg.number))).not.toBeNull();
  expect(await rows('ticket.viewed_by_staff')).toEqual([]);
});

test('скачивание файла сотрудником записано каждый раз, без имени файла; клиент и недоступный файл записи не оставляют', async () => {
  const f = await seedTwoOrgs();
  const file = async (status: string) => {
    const id = randomUUID();
    await pools.root.query(
      `insert into hdt_attachments (attachment_id, org_id, ticket_id, uploader_id, storage_key, file_name, mime, size, scan_status, is_internal)
       values ($1, $2, $3, $4, $5, 'паспорт-клиента.png', 'image/png', 10, $6, false)`,
      [id, f.orgA.orgId, f.tickets.aOrg.ticketId, f.aUser.userId, status === 'clean' ? `files/${f.orgA.orgId}/${id}` : `quarantine/${id}`, status],
    );
    return id;
  };
  const clean = await file('clean');
  const infected = await file('infected');
  const staff = staffCtx(f.l1);
  expect(await staffAttachmentRedirect(staff, clean, { inline: false })).not.toBeNull();
  expect(await staffAttachmentRedirect(staff, clean, { inline: true })).not.toBeNull();
  expect(await staffAttachmentRedirect(staff, infected, { inline: false })).toBeNull();
  expect(await staffAttachmentRedirect(staff, randomUUID(), { inline: false })).toBeNull();
  expect(await attachmentRedirect(await clientCtx(f.aUser), clean, { inline: false })).not.toBeNull();
  const logged = await rows('attachment.downloaded_by_staff');
  const expected = { actor_type: 'staff', actor_id: f.l1.userId, object_type: 'attachment', object_id: clean, org_id: f.orgA.orgId, diff: { ticketId: f.tickets.aOrg.ticketId } };
  expect(logged).toEqual([expected, expected]);
  expect(JSON.stringify(logged)).not.toContain('паспорт');
});
