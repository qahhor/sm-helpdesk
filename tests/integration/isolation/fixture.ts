import type { ClientActor, StaffActor } from '@/db/with-actor';
import { pools } from '../helpers/db';

// Данные набора изоляции (ТЗ 15.2): две организации А и Б, в каждой обычный пользователь и администратор,
// три сотрудника. Строки создаются под суперпользователем и не зависят от сервисов:
// ошибка в сервисе не должна прятать ошибку в политике.

export type ClientMember = { userId: string; name: string; actor: ClientActor };
export type StaffMember = { userId: string; name: string; actor: StaffActor };

export type Fixture = {
  server: { serverId: string; code: string };
  orgA: { orgId: string; name: string };
  orgB: { orgId: string; name: string };
  aUser: ClientMember;
  aAdmin: ClientMember;
  bUser: ClientMember;
  bAdmin: ClientMember;
  care: StaffMember;
  l1: StaffMember;
  adminStaff: StaffMember;
};

/** Запечатанный вид секрета: проверка базы не пускает в колонку открытый текст. */
export const SEALED = 'v1.aXY.dGFn.ZGF0YQ';

let serial = 0;

async function user(name: string): Promise<string> {
  serial += 1;
  const r = await pools.root.query(
    `insert into auth."user" (name, email, "emailVerified") values ($1, $2, false) returning id`,
    [name, `u-fixture-${serial}-${Date.now()}@users.invalid`],
  );
  return r.rows[0].id as string;
}

async function organization(serverId: string, externalId: string, name: string) {
  const r = await pools.root.query(
    `insert into hdu_organizations (server_id, external_company_id, name) values ($1, $2, $3) returning org_id`,
    [serverId, externalId, name],
  );
  return { orgId: r.rows[0].org_id as string, name };
}

async function member(orgId: string, name: string, orgRole: ClientActor['orgRole']): Promise<ClientMember> {
  const userId = await user(name);
  await pools.root.query(
    `insert into hdu_memberships (org_id, user_id, role, source) values ($1, $2, $3, 'smartup')`,
    [orgId, userId, orgRole],
  );
  return { userId, name, actor: { type: 'client', userId, orgId, orgRole } };
}

async function staff(name: string, staffRole: StaffActor['staffRole']): Promise<StaffMember> {
  const userId = await user(name);
  await pools.root.query(`insert into hdu_staff (user_id, role) values ($1, $2)`, [userId, staffRole]);
  return { userId, name, actor: { type: 'staff', userId, staffRole } };
}

async function invitation(orgId: string, email: string, invitedBy: string): Promise<void> {
  await pools.root.query(
    `insert into hdu_invitations (org_id, email, role, token_hash, invited_by, expires_on)
     values ($1, $2, 'client_user', encode(sha256(($2 || random()::text)::bytea), 'hex'), $3, now() + interval '7 days')`,
    [orgId, email, invitedBy],
  );
}

export async function seedTwoOrgs(): Promise<Fixture> {
  serial += 1;
  const code = `fixture-${serial}`;
  const server = (
    await pools.root.query(
      `insert into hdu_servers (name, base_url, issuer, oauth_client_id, oauth_client_secret, code)
       values ('Облако', $1, $1, 'hub', $2, $3) returning server_id`,
      [`https://${code}.smartup.example`, SEALED, code],
    )
  ).rows[0].server_id as string;

  const orgA = await organization(server, '501', 'ACME Trade');
  const orgB = await organization(server, '502', 'Globex');
  const aUser = await member(orgA.orgId, 'Алишер', 'client_user');
  const aAdmin = await member(orgA.orgId, 'Дильноза', 'client_admin');
  const bUser = await member(orgB.orgId, 'Тимур', 'client_user');
  const bAdmin = await member(orgB.orgId, 'Зарина', 'client_admin');
  const care = await staff('Камила', 'care');
  const l1 = await staff('Азиз', 'agent_l1');
  const adminStaff = await staff('Рустам', 'admin');
  await invitation(orgA.orgId, 'invited-a@acme.test', aAdmin.userId);
  await invitation(orgB.orgId, 'invited-b@globex.test', bAdmin.userId);

  return { server: { serverId: server, code }, orgA, orgB, aUser, aAdmin, bUser, bAdmin, care, l1, adminStaff };
}
