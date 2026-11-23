import { drizzle } from 'drizzle-orm/node-postgres';
import { beforeEach, expect, test } from 'vitest';
import { getTicket, listTickets, replyToTicket } from '@/modules/hdt/api';
import { findDownloadable } from '@/modules/hdt/core/attachments';
import { clientTicketScope, ticketExists } from '@/modules/hdt/core/tickets';
import { tickets } from '@/modules/hdt/schema';
import { clientCtx } from './helpers/auth';
import { pools } from './helpers/db';
import { type Fixture, seedTwoOrgs } from './isolation/fixture';

// Второй слой изоляции (аудит 23.11.2026, находки P1, S7): чтения клиента несут условие по организации из актора.
// Политики RLS остаются первым слоем. Здесь они выключаются на время теста в тестовой базе: условие в запросе
// должно удержать границу организации само. Файлы интеграционных тестов идут по очереди, RLS возвращается в finally.

const TABLES = ['hdt_tickets', 'hdt_attachments', 'hdt_ticket_messages', 'hdt_ticket_events', 'hdt_ticket_watchers'] as const;
let f: Fixture;
beforeEach(async () => {
  f = await seedTwoOrgs();
});

async function withoutRls<T>(fn: () => Promise<T>): Promise<T> {
  for (const table of TABLES) await pools.root.query(`alter table ${table} no force row level security, disable row level security`);
  try {
    return await fn();
  } finally {
    for (const table of TABLES) await pools.root.query(`alter table ${table} enable row level security, force row level security`);
    const state = await pools.root.query(`select relname from pg_class where relname = any($1) and not (relrowsecurity and relforcerowsecurity)`, [TABLES]);
    expect(state.rows).toEqual([]);
  }
}

test('условие клиента отдаёт только обращения его организации даже без RLS', async () => {
  const rows = await drizzle(pools.root).select({ orgId: tickets.orgId }).from(tickets).where(clientTicketScope(f.aUser.actor));
  expect(rows.length).toBeGreaterThan(0);
  expect(new Set(rows.map((r) => r.orgId))).toEqual(new Set([f.orgA.orgId]));
});

test('список, обращение по номеру, ответ и скачивание вложения клиента несут условие по организации', async () => {
  const ctx = await clientCtx(f.aUser);
  const [foreign] = (await pools.root.query(`select attachment_id from hdt_attachments where org_id = $1 and scan_status = 'clean' and not is_internal limit 1`, [f.orgB.orgId])).rows;
  await pools.root.query(`update hdt_attachments set storage_key = 'files/x' where attachment_id = $1`, [foreign.attachment_id]);
  await withoutRls(async () => {
    const listed = await listTickets(ctx, {});
    expect(listed.items.length).toBeGreaterThan(0);
    expect(listed.items.map((t) => t.number)).not.toContain(f.tickets.bOrg.number);
    expect(listed.items.map((t) => t.number)).not.toContain(f.tickets.bPrivate.number);
    expect(await getTicket(ctx, f.tickets.bOrg.number)).toBeNull();
    expect(await ticketExists(f.aUser.actor, f.tickets.bOrg.number)).toBe(false);
    await expect(replyToTicket(ctx, { number: f.tickets.bOrg.number, body: 'чужое' })).rejects.toThrow();
    expect(await findDownloadable(f.aUser.actor, foreign.attachment_id)).toBeNull();
    // Своё по-прежнему читается.
    expect(await getTicket(ctx, f.tickets.aOrg.number)).not.toBeNull();
  });
});
