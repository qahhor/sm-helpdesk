import { randomUUID } from 'node:crypto';
import type { ClientActor, StaffActor } from '@/db/with-actor';
import { pools } from '../helpers/db';

// Данные набора изоляции (ТЗ 15.2): две организации А и Б, в каждой обычный пользователь и администратор,
// три сотрудника, обращения с сообщениями, заметками и вложениями. Строки создаются под суперпользователем и не зависят от сервисов:
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
  /** Обращения (ТЗ 15.2): в каждой организации обращение для всей организации и личное. */
  tickets: {
    /** Автор aUser, видимость org, есть чистое и непроверенное вложение и внутреннее вложение. */
    aOrg: TicketRef;
    /** Автор aAdmin, личное: aUser его не видит. */
    aPrivate: TicketRef;
    /** Автор aUser, личное: его видит администратор клиента aAdmin. */
    aMine: TicketRef;
    bOrg: TicketRef;
    bPrivate: TicketRef;
  };
};

export type TicketRef = { ticketId: string; number: number; title: string };

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

/** Обращение с публичным сообщением, внутренней заметкой, событием создания, внутренним событием и подпиской автора. */
async function ticket(orgId: string, authorId: string, visibility: 'org' | 'private', title: string, staffId: string): Promise<TicketRef> {
  const r = await pools.root.query(
    `insert into hdt_tickets (org_id, author_id, type, impact, priority, visibility, title, description, locale, source)
     values ($1, $2, 'bug', 'major', 'p2', $3, $4, $4 || ': подробное описание', 'ru', 'portal') returning ticket_id, number`,
    [orgId, authorId, visibility, title],
  );
  const ticketId = r.rows[0].ticket_id as string;
  await pools.root.query(
    `insert into hdt_ticket_messages (org_id, ticket_id, author_id, author_type, body, is_internal)
     values ($1, $2, $3, 'client', 'Публичное сообщение', false), ($1, $2, $4, 'staff', 'Внутренняя заметка', true)`,
    [orgId, ticketId, authorId, staffId],
  );
  await pools.root.query(
    `insert into hdt_ticket_events (org_id, ticket_id, kind, actor_type, actor_id, payload, is_internal)
     values ($1, $2, 'created', 'client', $3, '{}', false), ($1, $2, 'queue', 'staff', $4, '{"to":"l2"}', true)`,
    [orgId, ticketId, authorId, staffId],
  );
  await pools.root.query(`insert into hdt_ticket_watchers (org_id, ticket_id, user_id, source) values ($1, $2, $3, 'author')`, [
    orgId,
    ticketId,
    authorId,
  ]);
  return { ticketId, number: Number(r.rows[0].number), title };
}

async function attachment(orgId: string, ticketId: string, uploaderId: string, scanStatus: string, isInternal = false): Promise<void> {
  await pools.root.query(
    `insert into hdt_attachments (org_id, ticket_id, uploader_id, storage_key, file_name, mime, size, scan_status, is_internal)
     values ($1, $2, $3, $6, 'screenshot.png', 'image/png', 1024, $4, $5)`,
    [orgId, ticketId, uploaderId, scanStatus, isInternal, `files/${orgId}/${randomUUID()}`],
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

  const tickets = {
    aOrg: await ticket(orgA.orgId, aUser.userId, 'org', 'Отчёт А не грузится', l1.userId),
    aPrivate: await ticket(orgA.orgId, aAdmin.userId, 'private', 'Личное обращение администратора А', l1.userId),
    aMine: await ticket(orgA.orgId, aUser.userId, 'private', 'Личное обращение пользователя А', l1.userId),
    bOrg: await ticket(orgB.orgId, bUser.userId, 'org', 'Секрет Б: накладная не проводится', l1.userId),
    bPrivate: await ticket(orgB.orgId, bAdmin.userId, 'private', 'Личное обращение администратора Б', l1.userId),
  };
  await attachment(orgA.orgId, tickets.aOrg.ticketId, aUser.userId, 'clean');
  await attachment(orgA.orgId, tickets.aOrg.ticketId, aAdmin.userId, 'pending');
  await attachment(orgA.orgId, tickets.aOrg.ticketId, l1.userId, 'clean', true);
  await attachment(orgB.orgId, tickets.bOrg.ticketId, bUser.userId, 'clean');
  // Очередь исходящих (веха M4): уже отправленное письмо, его не берёт отправка в тестах очереди.
  await pools.root.query(
    `insert into hdn_outbox (ticket_id, channel, recipient_kind, recipient_user_id, recipient, template, payload, status, attempts, external_id)
     values ($1, 'email', 'user', $2, 'fixture@acme.test', 'ticket_created', $3, 'sent', 1, $4)`,
    [tickets.aOrg.ticketId, aUser.userId, JSON.stringify({ template: 'ticket_created', number: tickets.aOrg.number, title: tickets.aOrg.title, url: '/tickets', viaEmail: false }), `fixture-${code}`],
  );

  // Уведомления и настройки писем (веха M4): у пользователей обеих организаций.
  for (const [orgId, user, t] of [
    [orgA.orgId, aUser, tickets.aOrg],
    [orgB.orgId, bUser, tickets.bOrg],
  ] as const) {
    await pools.root.query(`insert into hdn_notifications (org_id, user_id, ticket_id, kind, payload) values ($1, $2, $3, 'ticket_reply', $4)`, [
      orgId,
      user.userId,
      t.ticketId,
      JSON.stringify({ number: t.number }),
    ]);
    await pools.root.query(`insert into hdn_notification_prefs (user_id, kind, email_enabled) values ($1, 'watched_tickets', true)`, [user.userId]);
  }

  // Приём писем (веха M4): входящее письмо, цепочка, отклонённый адрес, домен организации, слияние гостя.
  await pools.root.query(
    `insert into hdn_email_inbound (ticket_id, provider_id, from_address, raw_ref, received_on, classification)
     values ($1, $2, 'author-a@acme.test', $2, now(), 'reply')`,
    [tickets.aOrg.ticketId, `fixture-${code}`],
  );
  await pools.root.query(`insert into hdn_email_threads (ticket_id, message_id, direction) values ($1, $2, 'out')`, [tickets.aOrg.ticketId, `<fixture-${code}@reply.test>`]);
  await pools.root.query(`insert into hdn_blocked_senders (address, blocked_by) values ($1, $2)`, [`spam-${code}@spam.test`, l1.userId]);
  await pools.root.query(`insert into hdu_org_email_domains (org_id, domain, added_by) values ($1, $2, $3)`, [orgA.orgId, `${code}.acme.test`, care.userId]);
  await pools.root.query(`insert into hdu_guest_merges (guest_user_id, user_id) values ($1, $2)`, [bUser.userId, aUser.userId]);
  // Токен бота дежурных (веха M4): строка одна на базу.
  await pools.root.query(`insert into hdn_channel_secrets (code, sealed) values ('oncall_telegram_bot', $1) on conflict (code) do nothing`, [SEALED]);

  return { server: { serverId: server, code }, orgA, orgB, aUser, aAdmin, bUser, bAdmin, care, l1, adminStaff, tickets };
}
