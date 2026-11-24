import { beforeEach, expect, test } from 'vitest';
import { cleanupInbound, cleanupOutbox } from '@/modules/hdn/api/maintenance';
import { asActor, pools } from './helpers/db';
import { type Fixture, seedTwoOrgs } from './isolation/fixture';

// Сроки хранения служебных данных почты (аудит 23.11.2026, находка P6; план W1, задача 4): отправленные строки
// очереди исходящих живут 30 суток (в них текст письма), разобранные входящие письма 90 суток.

const SYSTEM = { type: 'system', job: 'maintenance.cleanup' } as const;
let f: Fixture;
beforeEach(async () => {
  f = await seedTwoOrgs();
  await pools.root.query(`delete from hdn_outbox`);
  await pools.root.query(`delete from hdn_email_inbound`);
});

/** Строка очереди с заданным статусом и возрастом в сутках. Время создания ставится в обход триггера. */
async function outboxRow(status: string, ageDays: number): Promise<string> {
  const client = await pools.root.connect();
  try {
    await client.query('begin');
    await client.query(`set local session_replication_role = replica`);
    const row = await client.query(
      `insert into hdn_outbox (ticket_id, channel, recipient_kind, recipient_user_id, template, payload, status, created_on, modified_on)
       values ($1, 'email', 'user', $2, 'ticket_reply', $3, $4, now() - make_interval(days => $5), now() - make_interval(days => $5)) returning outbox_id`,
      [f.tickets.aOrg.ticketId, f.aUser.userId, JSON.stringify({ template: 'ticket_reply', number: 1, title: 'x', url: '/tickets', body: 'Текст ответа клиенту' }), status, ageDays],
    );
    await client.query('commit');
    return row.rows[0].outbox_id as string;
  } finally {
    client.release();
  }
}

async function inboundRow(processed: boolean, ageDays: number): Promise<string> {
  const client = await pools.root.connect();
  try {
    await client.query('begin');
    await client.query(`set local session_replication_role = replica`);
    const row = await client.query(
      `insert into hdn_email_inbound (provider_id, from_address, subject, message_id, raw_ref, received_on, processed_on, created_on)
       values (gen_random_uuid()::text, 'x@example.uz', 'Тема', '<' || gen_random_uuid() || '@example.uz>', 'ref', now() - make_interval(days => $2),
               case when $1 then now() - make_interval(days => $2) end, now() - make_interval(days => $2)) returning inbound_id`,
      [processed, ageDays],
    );
    await client.query('commit');
    return row.rows[0].inbound_id as string;
  } finally {
    client.release();
  }
}

const left = (table: string, column: string) => pools.root.query(`select ${column} as id from ${table}`).then((r) => r.rows.map((row) => row.id as string));

test('очередь исходящих: отправленные, доставленные и пропущенные старше 30 суток удаляются, остальное остаётся', async () => {
  const oldSent = await outboxRow('sent', 31);
  const oldDelivered = await outboxRow('delivered', 45);
  const oldSkipped = await outboxRow('skipped', 31);
  const freshSent = await outboxRow('sent', 29);
  const oldFailed = await outboxRow('failed', 200);
  const oldQueued = await outboxRow('queued', 31);
  expect(await cleanupOutbox(SYSTEM, new Date())).toBe(3);
  const rows = await left('hdn_outbox', 'outbox_id');
  expect(rows.sort()).toEqual([freshSent, oldFailed, oldQueued].sort());
  expect(rows).not.toContain(oldSent);
  expect(rows).not.toContain(oldDelivered);
  expect(rows).not.toContain(oldSkipped);
});

test('входящие письма: разобранные старше 90 суток удаляются, неразобранные и свежие остаются', async () => {
  const old = await inboundRow(true, 91);
  const fresh = await inboundRow(true, 89);
  const stuck = await inboundRow(false, 200);
  expect(await cleanupInbound(SYSTEM, new Date())).toBe(1);
  const rows = await left('hdn_email_inbound', 'inbound_id');
  expect(rows.sort()).toEqual([fresh, stuck].sort());
  expect(rows).not.toContain(old);
});

test('удаляет только система: сотрудник и клиент строки очереди и входящих не удаляют', async () => {
  const sent = await outboxRow('sent', 31);
  const letter = await inboundRow(true, 91);
  for (const actor of [f.adminStaff.actor, f.aUser.actor]) {
    const tried = await asActor(pools.app, actor, async (c) => [
      (await c.query(`delete from hdn_outbox where outbox_id = $1`, [sent])).rowCount,
      (await c.query(`delete from hdn_email_inbound where inbound_id = $1`, [letter])).rowCount,
    ]).catch(() => [0, 0]);
    expect(tried).toEqual([0, 0]);
  }
  expect(await left('hdn_outbox', 'outbox_id')).toEqual([sent]);
});

// --- Журнал аудита хранится 3 года (вопрос 16, решение владельца 24.11.2026; план W4, задача 3) ---

async function auditRow(ageDays: number): Promise<string> {
  const row = await pools.root.query(
    `insert into hdc_audit_log (actor_type, action, object_type, object_id, created_on)
     values ('system', 'settings.changed', 'setting', 'probe-' || $1::text, now() - make_interval(days => $1::int)) returning audit_id`,
    [ageDays],
  );
  return row.rows[0].audit_id as string;
}
const auditIds = async () => new Set((await pools.root.query(`select audit_id from hdc_audit_log where object_id like 'probe-%'`)).rows.map((r) => r.audit_id as string));

test('ночная очистка удаляет записи журнала аудита старше 3 лет и не трогает остальные', async () => {
  const { cleanupAudit } = await import('@/modules/hdc/api');
  const old = await auditRow(3 * 365 + 2);
  const edge = await auditRow(3 * 365 - 2);
  const fresh = await auditRow(1);
  expect(await cleanupAudit(SYSTEM)).toBe(1);
  const left = await auditIds();
  expect(left.has(old)).toBe(false);
  expect(left.has(edge)).toBe(true);
  expect(left.has(fresh)).toBe(true);
  expect(await cleanupAudit(SYSTEM)).toBe(0);
});

test('журнал аудита не удаляет никто, кроме системы, и никто не удаляет записи моложе 3 лет', async () => {
  const old = await auditRow(3 * 365 + 2);
  const fresh = await auditRow(1);
  // Сотрудник, администратор и клиент: удаление не проходит (нет права или политика не пускает ни одну строку).
  for (const who of [f.adminStaff.actor, f.l1.actor, f.aAdmin.actor]) {
    const removed = await asActor(pools.app, who, (db) => db.query(`delete from hdc_audit_log where object_id like 'probe-%' returning audit_id`)).then(
      (r) => r.rows.length,
      () => 0,
    );
    expect(removed, who.type).toBe(0);
  }
  // Система: свежая запись не удаляется даже прямым запросом без условия на возраст.
  const bySystem = await asActor(pools.app, SYSTEM, (db) => db.query(`delete from hdc_audit_log where object_id like 'probe-%' returning audit_id`));
  expect(bySystem.rows.map((r) => r.audit_id)).toEqual([old]);
  expect((await auditIds()).has(fresh)).toBe(true);
});
