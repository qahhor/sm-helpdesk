import { afterEach, beforeEach, expect, test } from 'vitest';
import { setLogSinkForTests } from '@/lib/log';
import { dispatchOutbox } from '@/modules/hdn/api/outbox';
import { createMemoryEmailProvider, type MemoryEmailProvider } from '@/modules/hdn/testing';
import { getTicket } from '@/modules/hdt/api';
import { anonymizeAccount } from '@/modules/hdu/api/accounts';
import { changeMemberRole } from '@/modules/hdu/api/members';
import { clientCtx, staffCtx } from './helpers/auth';
import { pools } from './helpers/db';
import { type Fixture, seedTwoOrgs } from './isolation/fixture';

// Следы обезличенной учётной записи за пределами таблицы пользователей (проверка W7, находка R3; решение 0162):
// приглашения на адрес, очередь исходящих, разобранные входящие письма.

const DISPATCH = { type: 'system', job: 'outbox.dispatch' } as const;
const EMAIL = 'alisher.karimov@acme.test';
const FULL_NAME = 'Алишер Каримов';
let f: Fixture;
let provider: MemoryEmailProvider;

beforeEach(async () => {
  f = await seedTwoOrgs();
  provider = createMemoryEmailProvider();
  setLogSinkForTests(() => undefined);
  await pools.root.query(`update auth."user" set email = $2, "emailVerified" = true, name = $3 where id = $1`, [f.aUser.userId, EMAIL, FULL_NAME]);
  await pools.root.query(`update auth."user" set email = 'b-user@other.test', "emailVerified" = true where id = $1`, [f.bUser.userId]);
});
afterEach(() => setLogSinkForTests(null));

const one = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => (await pools.root.query(sql, params)).rows[0] as T;
const audit = (action: string) => pools.root.query(`select actor_type, actor_id, object_id, diff from hdc_audit_log where action = $1 order by created_on`, [action]).then((r) => r.rows);
/** Сколько строк таблицы содержат текст в любой колонке. */
const mentions = async (table: string, text: string) => (await one<{ n: number }>(`select count(*)::int as n from ${table} t where row_to_json(t)::text ilike '%' || $1 || '%'`, [text])).n;

async function queued(userId: string, ticketId: string, number: number, extra: Record<string, unknown> = {}): Promise<string> {
  return (
    await one<{ outbox_id: string }>(
      `insert into hdn_outbox (ticket_id, channel, recipient_kind, recipient_user_id, template, payload, locale, status, attempts, next_attempt_on)
       values ($1, 'email', 'user', $2, 'ticket_resolved', $3, 'ru', 'queued', 0, now() - interval '1 minute') returning outbox_id`,
      [ticketId, userId, JSON.stringify({ template: 'ticket_resolved', number, title: 'Отчёт', url: `/tickets/${number}`, ...extra })],
    )
  ).outbox_id;
}

async function seedTraces() {
  // Приглашения на адрес: ждущее в своей организации и уже принятое; чужое приглашение из заготовки не трогается.
  const pending = (
    await one<{ invitation_id: string }>(
      `insert into hdu_invitations (org_id, email, role, name, token_hash, invited_by, expires_on) values ($1, $2, 'client_user', $3, encode(sha256('p'::bytea || uuidv7()::text::bytea), 'hex'), $4, now() + interval '7 days') returning invitation_id`,
      [f.orgA.orgId, EMAIL, FULL_NAME, f.aAdmin.userId],
    )
  ).invitation_id;
  const accepted = (
    await one<{ invitation_id: string }>(
      `insert into hdu_invitations (org_id, email, role, name, token_hash, invited_by, expires_on, accepted_on) values ($1, $2, 'client_user', $3, encode(sha256('a'::bytea || uuidv7()::text::bytea), 'hex'), $4, now() - interval '1 day', now() - interval '2 days') returning invitation_id`,
      [f.orgA.orgId, EMAIL, FULL_NAME, f.aAdmin.userId],
    )
  ).invitation_id;
  // Очередь исходящих: ждущее письмо обезличиваемому (с именем в данных письма), отправленное (строка заготовки с адресом), ждущее чужое.
  const mine = await queued(f.aUser.userId, f.tickets.aOrg.ticketId, f.tickets.aOrg.number, { recipientName: FULL_NAME });
  await pools.root.query(`update hdn_outbox set recipient = $2 where recipient_user_id = $1 and status = 'sent'`, [f.aUser.userId, EMAIL]);
  const other = await queued(f.bUser.userId, f.tickets.bOrg.ticketId, f.tickets.bOrg.number);
  // Входящие письма: разобранное от этого адреса, чужое с этим адресом в копии, ещё не разобранное от этого адреса.
  const inbound = async (providerId: string, from: string, fromName: string | null, cc: string[], processed: boolean) =>
    (
      await one<{ inbound_id: string }>(
        `insert into hdn_email_inbound (provider_id, from_address, from_name, cc_addresses, subject, headers, raw_ref, received_on, processed_on, classification)
         values ($1, $2, $3, $4, 'Вопрос по отчёту', $5, $1, now(), ${processed ? 'now()' : 'null'}, ${processed ? `'new'` : 'null'}) returning inbound_id`,
        [providerId, from, fromName, cc, JSON.stringify([['From', `${fromName ?? ''} <${from}>`], ['Cc', cc.join(', ')]])],
      )
    ).inbound_id;
  const own = await inbound(`own-${f.server.code}`, EMAIL, FULL_NAME, [], true);
  const copied = await inbound(`cc-${f.server.code}`, 'colleague@acme.test', 'Коллега', [EMAIL, 'third@acme.test'], true);
  const waiting = await inbound(`wait-${f.server.code}`, EMAIL, FULL_NAME, [], false);
  return { pending, accepted, mine, other, own, copied, waiting };
}

test('обезличивание убирает адрес и имя из приглашений, очереди исходящих и разобранных входящих; ждущее письмо на старый адрес не уходит', async () => {
  const t = await seedTraces();
  const admin = staffCtx(f.adminStaff);
  expect(await mentions('hdu_invitations', EMAIL)).toBe(2);
  expect(await mentions('hdn_outbox', EMAIL)).toBe(1);
  expect(await mentions('hdn_outbox', FULL_NAME)).toBe(1);

  await anonymizeAccount(admin, { userId: f.aUser.userId });

  // Приглашения: ждущее отозвано, у обоих нет ни адреса, ни имени; чужое приглашение заготовки цело.
  const invitations = (await pools.root.query(`select invitation_id, email, name, revoked_on, accepted_on from hdu_invitations where invitation_id = any($1) order by accepted_on nulls first`, [[t.pending, t.accepted]])).rows;
  expect(invitations).toHaveLength(2);
  for (const row of invitations) {
    expect(row.email).toMatch(/^anon-[0-9a-f-]{36}@anonymized\.invalid$/);
    expect(row.name).toBeNull();
  }
  expect(invitations[0].revoked_on).not.toBeNull();
  expect(invitations[1].revoked_on).toBeNull();
  expect(await mentions('hdu_invitations', EMAIL)).toBe(0);
  expect(await mentions('hdu_invitations', FULL_NAME)).toBe(0);
  expect(await mentions('hdu_invitations', 'invited-a@acme.test')).toBe(1);

  // Очередь исходящих: ждущее письмо снято, адреса и данных письма в строках получателя нет; чужое письмо ждёт.
  const rows = (await pools.root.query(`select status, recipient, payload from hdn_outbox where recipient_user_id = $1 order by status`, [f.aUser.userId])).rows;
  expect(rows).toEqual([
    { status: 'sent', recipient: null, payload: { template: 'ticket_created' } },
    { status: 'skipped', recipient: null, payload: { template: 'ticket_resolved' } },
  ]);
  expect(await mentions('hdn_outbox', EMAIL)).toBe(0);
  expect(await mentions('hdn_outbox', FULL_NAME)).toBe(0);
  expect((await one<{ status: string }>(`select status from hdn_outbox where outbox_id = $1`, [t.other])).status).toBe('queued');

  // Отправка очереди: письмо уходит только чужому получателю.
  await dispatchOutbox(DISPATCH, new Date(), provider);
  expect(provider.sent.map((item) => item.message.to)).toEqual(['b-user@other.test']);

  // Входящие: в разобранных письмах адреса и имени нет, чужой адрес в копии остался; неразобранное письмо ждёт разбора.
  expect(await one(`select from_address, from_name, headers from hdn_email_inbound where inbound_id = $1`, [t.own])).toEqual({ from_address: 'anonymized@anonymized.invalid', from_name: null, headers: null });
  expect(await one(`select from_address, from_name, cc_addresses, headers from hdn_email_inbound where inbound_id = $1`, [t.copied])).toEqual({ from_address: 'colleague@acme.test', from_name: 'Коллега', cc_addresses: ['third@acme.test'], headers: null });
  expect((await one<{ from_address: string }>(`select from_address from hdn_email_inbound where inbound_id = $1`, [t.waiting])).from_address).toBe(EMAIL);
  expect(await mentions('hdn_email_inbound', EMAIL)).toBe(1);

  // Журнал: число приглашений в записи обезличивания, отдельная запись о следах почты от имени системы; без адреса и имени.
  const done = await audit('user.anonymized');
  expect(done).toHaveLength(1);
  expect(done[0].diff).toMatchObject({ invitations: 2 });
  // Идентификаторы приглашений (не адреса и не имена) лежат в записи: по ним повтор действия находит строки (B2).
  expect([...(done[0].diff.invitationIds as string[])].sort()).toEqual([t.pending, t.accepted].sort());
  const mail = await audit('user.mail_anonymized');
  expect(mail).toEqual([{ actor_type: 'system', actor_id: null, object_id: f.aUser.userId, diff: { outbox: 2, inbound: 2 } }]);
  expect(JSON.stringify([...done, ...mail])).not.toContain(EMAIL);
  expect(JSON.stringify([...done, ...mail])).not.toContain(FULL_NAME);
});

test('письмо, поставленное в очередь после обезличивания, на старый адрес не уходит: адрес берётся в момент отправки; повтор действия дочищает очередь', async () => {
  const admin = staffCtx(f.adminStaff);
  await anonymizeAccount(admin, { userId: f.aUser.userId });
  // Строка появилась после обезличивания (действие, начатое раньше), а отправленная строка с адресом осталась от сбоя шага очистки.
  const late = await queued(f.aUser.userId, f.tickets.aOrg.ticketId, f.tickets.aOrg.number);
  await pools.root.query(`update hdn_outbox set recipient = $2 where recipient_user_id = $1 and status = 'sent'`, [f.aUser.userId, EMAIL]);
  expect(await dispatchOutbox(DISPATCH, new Date(), provider)).toEqual({ sent: 0, failed: 0, skipped: 1 });
  expect(provider.sent).toEqual([]);
  expect((await one<{ status: string }>(`select status from hdn_outbox where outbox_id = $1`, [late])).status).toBe('skipped');
  // Повтор действия по уже обезличенной записи: учётная запись не меняется, очередь дочищается.
  expect(await anonymizeAccount(admin, { userId: f.aUser.userId })).toMatchObject({ alreadyDone: true });
  expect(await mentions('hdn_outbox', EMAIL)).toBe(0);
  expect(await audit('user.anonymized')).toHaveLength(1);
});

test('процесс оборвался после фиксации обезличивания: повтор действия находит приглашения по идентификаторам из журнала аудита и стирает адрес и имя (проверка, B2)', async () => {
  const t = await seedTraces();
  const admin = staffCtx(f.adminStaff);
  await anonymizeAccount(admin, { userId: f.aUser.userId });
  // Как после обрыва между фиксацией и шагом следов: учётная запись обезличена, а в приглашениях прежние адрес и имя.
  await pools.root.query(`update hdu_invitations set email = $2, name = $3 where invitation_id = any($1)`, [[t.pending, t.accepted], EMAIL, FULL_NAME]);
  await pools.root.query(`update hdn_outbox set recipient = $2 where recipient_user_id = $1 and status = 'sent'`, [f.aUser.userId, EMAIL]);
  expect(await mentions('hdu_invitations', EMAIL)).toBe(2);
  expect(await mentions('hdu_invitations', FULL_NAME)).toBe(2);

  expect(await anonymizeAccount(admin, { userId: f.aUser.userId })).toMatchObject({ alreadyDone: true });

  expect(await mentions('hdu_invitations', EMAIL)).toBe(0);
  expect(await mentions('hdu_invitations', FULL_NAME)).toBe(0);
  expect(await mentions('hdn_outbox', EMAIL)).toBe(0);
  // Чужое приглашение заготовки цело, второй записи об обезличивании нет.
  expect(await mentions('hdu_invitations', 'invited-a@acme.test')).toBe(1);
  expect(await audit('user.anonymized')).toHaveLength(1);
  // Ещё один повтор ничего не меняет.
  const before = (await pools.root.query(`select invitation_id, email, name, modified_on from hdu_invitations where invitation_id = any($1) order by invitation_id`, [[t.pending, t.accepted]])).rows;
  expect(await anonymizeAccount(admin, { userId: f.aUser.userId })).toMatchObject({ alreadyDone: true });
  expect((await pools.root.query(`select invitation_id, email, name, modified_on from hdu_invitations where invitation_id = any($1) order by invitation_id`, [[t.pending, t.accepted]])).rows).toEqual(before);
});

test('сбой журнала в шаге обезличивания: приглашения не тронуты, как и учётная запись', async () => {
  const t = await seedTraces();
  await pools.root.query(`alter table hdc_audit_log add constraint w7_block check (action <> 'user.anonymized') not valid`);
  try {
    await expect(anonymizeAccount(staffCtx(f.adminStaff), { userId: f.aUser.userId })).rejects.toThrow();
  } finally {
    await pools.root.query(`alter table hdc_audit_log drop constraint w7_block`);
  }
  expect(await one(`select email, name, revoked_on from hdu_invitations where invitation_id = $1`, [t.pending])).toEqual({ email: EMAIL, name: FULL_NAME, revoked_on: null });
  expect((await one<{ status: string }>(`select status from hdn_outbox where outbox_id = $1`, [t.mine])).status).toBe('queued');
  expect((await one<{ from_address: string }>(`select from_address from hdn_email_inbound where inbound_id = $1`, [t.own])).from_address).toBe(EMAIL);
});

test('единственный администратор клиента обезличивается: организация и её обращения остаются, роль администратора сотрудник назначает другому участнику', async () => {
  const admin = staffCtx(f.adminStaff);
  // Личное обращение администратора клиента до обезличивания видит только он.
  expect(await getTicket(await clientCtx(f.aUser), String(f.tickets.aPrivate.number))).toBeNull();
  await anonymizeAccount(admin, { userId: f.aAdmin.userId });
  expect((await pools.root.query(`select role, state from hdu_memberships where org_id = $1 order by role`, [f.orgA.orgId])).rows).toEqual([
    { role: 'client_admin', state: 'passive' },
    { role: 'client_user', state: 'active' },
  ]);
  // Организация действует, участник работает как раньше: общее обращение видно, чужое личное по-прежнему нет.
  expect((await one<{ state: string }>(`select state from hdu_organizations where org_id = $1`, [f.orgA.orgId])).state).toBe('active');
  expect(await getTicket(await clientCtx(f.aUser), String(f.tickets.aOrg.number))).not.toBeNull();
  expect(await getTicket(await clientCtx(f.aUser), String(f.tickets.aPrivate.number))).toBeNull();
  // Обращения никуда не делись, а нового администратора назначает сотрудник care или admin: он видит и личные обращения прежнего.
  expect((await one<{ n: number }>(`select count(*)::int as n from hdt_tickets where org_id = $1`, [f.orgA.orgId])).n).toBe(3);
  await changeMemberRole(admin, { orgId: f.orgA.orgId, userId: f.aUser.userId, role: 'client_admin' });
  const promoted = { ...f.aUser, actor: { ...f.aUser.actor, orgRole: 'client_admin' as const } };
  expect(await getTicket(await clientCtx(promoted), String(f.tickets.aPrivate.number))).not.toBeNull();
});
