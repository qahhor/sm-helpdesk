import 'server-only';
import { sql } from 'drizzle-orm';
import type { Tx } from '@/db/client';
import { TIMELINE_MAX, TIMELINE_PAGE } from '../pref';

// Модуль hdt, слой core: окно истории обращения (аудит 23.11.2026, находка P11; план W2, задача 6).
// Страница обращения читает последние записи истории, а не всю переписку: сообщения и события вместе, по времени.
// Окно задаётся числом последних записей: 50, по ссылке "Показать раньше" 100, 150 и так далее. Число, а не отметка
// времени: у записей с одинаковым временем нет границы, на которой запись можно потерять или показать дважды.

/** Сколько последних записей показать: кратно странице, от 50 до 1000. Негодное значение: 50. */
export function timelineLimit(raw: unknown): number {
  const wanted = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : Number.NaN;
  if (!Number.isFinite(wanted) || wanted <= TIMELINE_PAGE) return TIMELINE_PAGE;
  return Math.min(TIMELINE_MAX, Math.ceil(wanted / TIMELINE_PAGE) * TIMELINE_PAGE);
}

export type TimelineWindow = {
  messageIds: string[];
  eventIds: string[];
  /** Место записи в истории от старых к новым: ключ "m:<id>" или "e:<id>". */
  order: Map<string, number>;
  hasEarlier: boolean;
  /** Время самой новой записи всей истории, а не окна: по нему страница узнаёт об изменениях (FR-AG-12). */
  latestOn: Date | null;
};

/**
 * Последние limit записей истории под политиками актора: клиент не получит внутренних записей ни в одном окне.
 * Порядок: время, при равном времени сообщение раньше события, затем идентификатор. skipCreated: событие
 * "создано" в историю сотрудника не входит.
 */
export async function timelineWindowTx(tx: Tx, ticketId: string, limit: number, opts: { skipCreated?: boolean } = {}): Promise<TimelineWindow> {
  const events = opts.skipCreated ? sql`and kind <> 'created'` : sql``;
  const rows = (
    await tx.execute<{ rank: number; id: string }>(sql`
      select rank, id from (
        select 0 as rank, message_id as id, created_on from hdt_ticket_messages where ticket_id = ${ticketId}::uuid
        union all
        select 1 as rank, event_id as id, created_on from hdt_ticket_events where ticket_id = ${ticketId}::uuid ${events}
      ) as history
      order by created_on desc, rank desc, id desc
      limit ${limit + 1}`)
  ).rows;
  const latest = (
    await tx.execute<{ at: Date | string | null }>(sql`
      select greatest(
        (select max(created_on) from hdt_ticket_messages where ticket_id = ${ticketId}::uuid),
        (select max(created_on) from hdt_ticket_events where ticket_id = ${ticketId}::uuid)
      ) as at`)
  ).rows[0]?.at;
  const shown = rows.slice(0, limit).reverse();
  const key = (row: { rank: number; id: string }) => `${Number(row.rank) === 0 ? 'm' : 'e'}:${row.id}`;
  return {
    messageIds: shown.filter((row) => Number(row.rank) === 0).map((row) => row.id),
    eventIds: shown.filter((row) => Number(row.rank) === 1).map((row) => row.id),
    order: new Map(shown.map((row, index) => [key(row), index])),
    hasEarlier: rows.length > limit,
    latestOn: latest ? new Date(latest) : null,
  };
}
