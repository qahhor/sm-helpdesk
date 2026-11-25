import 'server-only';
import { sql } from 'drizzle-orm';
import type { Tx } from '@/db/client';

// Модуль hdk, слой core: показатели подсказки (FR-MET-02; план M5, задача 11, решение 12). Строка исходов на сессию
// формы, исход один: помогло, не помогло, создано обращение или ушёл без действия. Период по времени первого показа.

export type Range = { from: Date; to: Date };
export type DeflectionCounters = { shown: number; helped: number; notHelped: number; ticketCreated: number; left: number };

const counters = sql`count(*)::int as shown,
       count(*) filter (where outcome = 'helped')::int as helped,
       count(*) filter (where outcome = 'not_helped')::int as not_helped,
       count(*) filter (where outcome = 'ticket_created')::int as ticket_created,
       count(*) filter (where outcome = 'left')::int as "left"`;

type Row = { shown: number; helped: number; not_helped: number; ticket_created: number; left: number };
const toCounters = (row: Row | undefined): DeflectionCounters => ({
  shown: row?.shown ?? 0,
  helped: row?.helped ?? 0,
  notHelped: row?.not_helped ?? 0,
  ticketCreated: row?.ticket_created ?? 0,
  left: row?.left ?? 0,
});

/** Сессии с показом подсказки за период и их исходы. */
export async function deflectionTotalsTx(tx: Tx, range: Range): Promise<DeflectionCounters> {
  const result = await tx.execute<Row>(sql`
    select ${counters}
      from hdk_deflection_events
     where created_on >= ${range.from.toISOString()}::timestamptz and created_on < ${range.to.toISOString()}::timestamptz`);
  return toCounters(result.rows[0]);
}

/** То же по организациям: больше показов первыми, не больше limit строк. */
export async function deflectionByOrgTx(tx: Tx, range: Range, limit: number): Promise<(DeflectionCounters & { orgId: string })[]> {
  const result = await tx.execute<Row & { org_id: string }>(sql`
    select org_id, ${counters}
      from hdk_deflection_events
     where created_on >= ${range.from.toISOString()}::timestamptz and created_on < ${range.to.toISOString()}::timestamptz
     group by org_id
     order by shown desc, org_id
     limit ${limit}`);
  return result.rows.map((row) => ({ orgId: row.org_id, ...toCounters(row) }));
}
