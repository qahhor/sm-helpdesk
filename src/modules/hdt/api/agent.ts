import 'server-only';
import { findOrgIds, findUserIds, namesOf, orgSummaries, type StaffContext } from '@/modules/hdu/api';
import { loadSlaConfig } from '@/modules/hdr/api';
import { calendarFor, type SlaPhase, slaPhase } from '../core/sla';
import {
  deleteFilterTx,
  listFiltersTx,
  type QueueKey,
  type QueueSearch,
  queueCountsTx,
  queueRowsTx,
  type SavedFilter,
  saveFilterTx,
} from '../core/agent-queues';
import { parseInput, queueInput, savedFilterInput } from '../input';
import type { Priority, Queue, TicketStatus } from '../pref';
import { workingMinutesBetween } from '../sla';
import { parseSearch } from '../util';
import * as z from 'zod';

// Модуль hdt, слой api: рабочее место сотрудника (план M3). Контекст сотрудника строит requireStaffActor:
// клиент и посетитель сюда не попадают. Читают все роли сотрудников, пишут все, кроме product (миграция 0021).

export const QUEUE_PAGE_SIZE = 50;

export type QueueRow = {
  number: number;
  title: string;
  status: TicketStatus;
  priority: Priority;
  orgName: string;
  assigneeName: string | null;
  line: Queue;
  dueOn: Date | null;
  slaPhase: SlaPhase;
  /** Рабочих минут до срока; у нарушенного 0. */
  minutesLeft: number | null;
  snoozedUntil: Date | null;
  clientWaitingSince: Date | null;
};

/** Строка поиска: номер и текст как у клиента, плюс организации по названию и ИНН и авторы по имени и адресу. */
async function searchOf(ctx: StaffContext, q: string | undefined): Promise<QueueSearch | undefined> {
  if (!q) return undefined;
  const parsed = parseSearch(q);
  const [orgIds, authorIds] = parsed.text ? await Promise.all([findOrgIds(ctx, parsed.text), findUserIds(ctx, parsed.text)]) : [[], []];
  return { number: parsed.number, text: parsed.text, orgIds, authorIds };
}

/** Очередь (FR-AG-01), по умолчанию по ближайшему сроку; поиск (FR-AG-10); по 50 строк. */
export async function listQueue(ctx: StaffContext, input: unknown): Promise<{ items: QueueRow[]; hasMore: boolean }> {
  const data = parseInput(queueInput, input ?? {});
  const rows = await queueRowsTx(ctx.actor, {
    queue: data.queue,
    sort: data.sort,
    search: await searchOf(ctx, data.q),
    offset: (data.page - 1) * QUEUE_PAGE_SIZE,
    limit: QUEUE_PAGE_SIZE + 1,
  });
  const page = rows.slice(0, QUEUE_PAGE_SIZE);
  const [config, orgs, names] = await Promise.all([
    loadSlaConfig(ctx.actor),
    orgSummaries(ctx, page.map((row) => row.orgId)),
    namesOf(ctx.actor, page.map((row) => row.assigneeId).filter((id): id is string => id !== null)),
  ]);
  const now = new Date();
  return {
    items: page.map((row) => {
      const cal = calendarFor(config, row.priority);
      return {
        number: row.number,
        title: row.title,
        status: row.status,
        priority: row.priority,
        orgName: orgs.get(row.orgId)?.name ?? '',
        assigneeName: row.assigneeId ? (names.get(row.assigneeId) ?? null) : null,
        line: row.queue,
        dueOn: row.dueOn,
        slaPhase: row.status === 'waiting_customer' || row.status === 'resolved' || row.status === 'closed' ? 'calm' : slaPhase(row.dueOn, row.createdOn, now, cal),
        minutesLeft: row.dueOn ? workingMinutesBetween(now, row.dueOn, cal) : null,
        snoozedUntil: row.snoozedUntil && row.snoozedUntil.getTime() > now.getTime() ? row.snoozedUntil : null,
        clientWaitingSince: row.clientWaitingSince,
      };
    }),
    hasMore: rows.length > QUEUE_PAGE_SIZE,
  };
}

export function queueCounts(ctx: StaffContext): Promise<Record<QueueKey, number>> {
  return queueCountsTx(ctx.actor);
}

export function listFilters(ctx: StaffContext): Promise<SavedFilter[]> {
  return listFiltersTx(ctx.actor);
}

export async function saveFilter(ctx: StaffContext, input: unknown): Promise<string> {
  const data = parseInput(savedFilterInput, input);
  return saveFilterTx(ctx.actor, data);
}

export async function deleteFilter(ctx: StaffContext, filterId: unknown): Promise<void> {
  await deleteFilterTx(ctx.actor, parseInput(z.uuid(), filterId));
}

export type { SavedFilter } from '../core/agent-queues';
export { QUEUE_KEYS, QUEUE_SORTS, type QueueKey, type QueueSort } from '../core/agent-queue-keys';
