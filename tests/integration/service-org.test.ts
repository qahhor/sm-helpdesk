import { expect, test } from 'vitest';
import { ensureGuest, ensureServiceOrg, findVerifiedUser, orgByEmailDomain } from '@/modules/hdu/api/guests';
import { resolveClient } from '@/modules/hdu/api/orgs';
import { isLoginLinkRecipient } from '@/modules/hdu/core/email';
import { SERVICE_ORG_ID } from '@/modules/hdu/pref';
import { clientSession } from './helpers/auth';
import { asActor, pools } from './helpers/db';
import { seedTwoOrgs } from './isolation/fixture';

// Служебная организация "Неопознанные" и гости (раздел 10.1, решения 12 и 15 вехи M4).

async function serviceTicket(authorId: string, visibility: 'org' | 'private' = 'private') {
  const r = await pools.root.query(
    `insert into hdt_tickets (org_id, author_id, type, impact, priority, visibility, title, description, locale, source)
     values ($1, $2, 'question', 'minor', 'p3', $3, 'Письмо', 'Текст', 'ru', 'email') returning ticket_id`,
    [SERVICE_ORG_ID, authorId, visibility],
  );
  return r.rows[0].ticket_id as string;
}

test('служебная организация одна, без сервера; клиентская без сервера не создаётся', async () => {
  await ensureServiceOrg();
  await ensureServiceOrg();
  const rows = await pools.root.query(`select org_id, kind, server_id, external_company_id, name from hdu_organizations where kind = 'service'`);
  expect(rows.rows).toEqual([{ org_id: SERVICE_ORG_ID, kind: 'service', server_id: null, external_company_id: null, name: 'Неопознанные' }]);
  await expect(pools.root.query(`insert into hdu_organizations (name, kind) values ('Вторая', 'service')`)).rejects.toThrow();
  await expect(pools.root.query(`insert into hdu_organizations (name) values ('Без сервера')`)).rejects.toThrow();
});

test('обращение служебной организации нельзя сделать видимым организации', async () => {
  const guest = await ensureGuest('ivan@example.uz', 'Ivan', SERVICE_ORG_ID);
  await expect(serviceTicket(guest.userId, 'org')).rejects.toThrow(/личное/);
  const ticketId = await serviceTicket(guest.userId);
  await expect(pools.root.query(`update hdt_tickets set visibility = 'org' where ticket_id = $1`, [ticketId])).rejects.toThrow(/личное/);
});

test('сотрудник меняет организацию только у обращения из "Неопознанных"; product и клиент не могут', async () => {
  const f = await seedTwoOrgs();
  const guest = await ensureGuest('ivan@example.uz', 'Ivan', SERVICE_ORG_ID);
  const ticketId = await serviceTicket(guest.userId);
  const move = (actor: Parameters<typeof asActor>[1], id: string, orgId: string) =>
    asActor(pools.app, actor, (c) => c.query(`update hdt_tickets set org_id = $2 where ticket_id = $1`, [id, orgId]).then((r) => r.rowCount));
  // Обращение клиента в другую организацию сотрудник не переносит.
  await expect(move(f.l1.actor, f.tickets.aOrg.ticketId, f.orgB.orgId)).rejects.toThrow(/нельзя/);
  // product только читает: строку не видит для изменения или получает отказ.
  const product = { ...f.l1.actor, staffRole: 'product' as const };
  await expect(move(product, ticketId, f.orgA.orgId).catch(() => 0)).resolves.toBe(0);
  // Клиент не меняет организацию.
  await expect(move(f.aUser.actor, f.tickets.aOrg.ticketId, f.orgB.orgId).catch(() => 0)).resolves.toBe(0);
  // Привязка из "Неопознанных" первой линией.
  expect(await move(f.l1.actor, ticketId, f.orgA.orgId)).toBe(1);
});

test('гость не входит по ссылке на email и через Smartup', async () => {
  const guest = await ensureGuest('Ivan@Example.UZ', 'Ivan Petrov', SERVICE_ORG_ID);
  const again = await ensureGuest('ivan@example.uz', null, SERVICE_ORG_ID);
  expect(again.userId).toBe(guest.userId);
  const user = (await pools.root.query(`select email, "emailVerified", "claimedEmail", name from auth."user" where id = $1`, [guest.userId])).rows[0];
  expect(user).toMatchObject({ emailVerified: false, claimedEmail: 'ivan@example.uz', name: 'Ivan Petrov' });
  expect(user.email).toMatch(/@users\.invalid$/);
  expect(await isLoginLinkRecipient('ivan@example.uz')).toBe(false);
  expect(await resolveClient(await clientSession({ userId: guest.userId }))).toEqual({ denied: 'no_organization' });
  expect(await findVerifiedUser('ivan@example.uz')).toBeNull();
});

test('подтверждённый пользователь находится по адресу, домен организации по домену', async () => {
  const f = await seedTwoOrgs();
  await pools.root.query(`update auth."user" set email = 'anvar@acme.test', "emailVerified" = true, "lastOrgId" = $2 where id = $1`, [f.aUser.userId, f.orgA.orgId]);
  expect(await findVerifiedUser('Anvar@Acme.Test')).toEqual({ userId: f.aUser.userId, lastOrgId: f.orgA.orgId });
  await pools.root.query(`insert into hdu_org_email_domains (org_id, domain, added_by) values ($1, 'acme.test', $2)`, [f.orgA.orgId, f.care.userId]);
  expect(await orgByEmailDomain('ACME.test')).toBe(f.orgA.orgId);
  expect(await orgByEmailDomain('globex.test')).toBeNull();
});
