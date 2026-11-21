import 'server-only';
import { findOrgIds, findUserIds, namesOf, type OrgSummary, orgSummaries, type StaffContext, verifiedEmails } from '@/modules/hdu/api';
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
import { markReadTx, readAgentTicketTx } from '../core/agent-ticket';
import { parseInput, queueInput, savedFilterInput } from '../input';
import { type AuthorType, type EventKind, type Impact, INLINE_IMAGE_TYPES, type Priority, type Queue, type ScanStatus, type TicketSource, type TicketStatus, type TicketType, type Visibility } from '../pref';
import { workingMinutesBetween } from '../sla';
import { parseNumber, parseSearch, rejectReasonOf } from '../util';
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

// --- Обращение у сотрудника (план M3, задача 6) ---

export type AgentFileView = {
  attachmentId: string;
  fileName: string;
  mime: string;
  size: number;
  scanStatus: ScanStatus;
  rejectReason: ReturnType<typeof rejectReasonOf>;
  isInternal: boolean;
  /** Чистый файл: можно открыть и скачать. */
  canOpen: boolean;
  /** Картинка или PDF: открывается в окне просмотра (UX-A-14). */
  canPreview: boolean;
};

export type AgentTimelineEntry =
  | {
      type: 'message';
      id: string;
      authorType: AuthorType;
      authorName: string | null;
      isInternal: boolean;
      body: string;
      createdOn: Date;
      attachments: AgentFileView[];
      isNew: boolean;
    }
  | { type: 'event'; id: string; kind: EventKind; payload: Record<string, unknown>; actorName: string | null; isInternal: boolean; createdOn: Date; isNew: boolean };

export type AgentTicketView = {
  ticketId: string;
  number: number;
  title: string;
  description: string;
  status: TicketStatus;
  type: TicketType;
  impact: Impact;
  priority: Priority;
  priorityConfirmed: boolean;
  visibility: Visibility;
  line: Queue;
  source: TicketSource;
  locale: string;
  moduleId: string | null;
  createdOn: Date;
  author: { id: string; name: string | null; email: string | null };
  assignee: { id: string; name: string | null } | null;
  org: OrgSummary | null;
  sla: { firstResponseDueOn: Date | null; resolutionDueOn: Date | null; firstRespondedOn: Date | null; pausedSince: Date | null; phase: SlaPhase; minutesLeft: number | null };
  context: unknown;
  resolutionType: string | null;
  resolvedVersion: string | null;
  snoozedUntil: Date | null;
  /** Прошлый визит этого сотрудника (UX-A-15): всё, что позже, отмечено как новое. */
  changedSince: Date | null;
  /** Время последнего изменения обращения: по нему ответ узнаёт, что обращение изменилось после открытия (FR-AG-12). */
  version: string;
  attachments: AgentFileView[];
  timeline: AgentTimelineEntry[];
};

const PREVIEW_TYPES: readonly string[] = [...INLINE_IMAGE_TYPES, 'application/pdf'];

/** Обращение по номеру (SUP-1042 или 1042) глазами сотрудника. Нет такого: null. */
export async function getAgentTicket(ctx: StaffContext, numberRaw: unknown): Promise<AgentTicketView | null> {
  const number = typeof numberRaw === 'string' ? parseNumber(numberRaw) : typeof numberRaw === 'number' ? numberRaw : null;
  if (number === null) return null;
  const found = await readAgentTicketTx(ctx.actor, number);
  if (!found) return null;
  const { ticket, seenOn } = found;
  const people = [ticket.authorId, ticket.assigneeId, ...found.messages.map((m) => m.authorId), ...found.events.map((e) => e.actorId)].filter(
    (id): id is string => id !== null,
  );
  const [names, orgs, emails, config] = await Promise.all([
    namesOf(ctx.actor, people),
    orgSummaries(ctx, [ticket.orgId]),
    verifiedEmails(ctx, [ticket.authorId]),
    loadSlaConfig(ctx.actor),
  ]);
  const isNew = (at: Date) => seenOn !== null && at.getTime() > seenOn.getTime();
  const fileView = (a: (typeof found.attachments)[number]): AgentFileView => ({
    attachmentId: a.attachmentId,
    fileName: a.fileName,
    mime: a.mime,
    size: a.size,
    scanStatus: a.scanStatus,
    rejectReason: a.scanStatus === 'rejected' ? rejectReasonOf(a.scanSignature) : null,
    isInternal: a.isInternal,
    canOpen: a.scanStatus === 'clean',
    canPreview: a.scanStatus === 'clean' && PREVIEW_TYPES.includes(a.mime),
  });
  const cal = calendarFor(config, ticket.priority);
  const now = new Date();
  const dueOn = ticket.firstRespondedOn ? ticket.resolutionDueOn : ticket.firstResponseDueOn;
  const settled = ticket.status === 'waiting_customer' || ticket.status === 'resolved' || ticket.status === 'closed';
  const timeline: AgentTimelineEntry[] = [
    ...found.messages.map(
      (m): AgentTimelineEntry => ({
        type: 'message',
        id: m.messageId,
        authorType: m.authorType,
        authorName: m.authorId ? (names.get(m.authorId) ?? null) : null,
        isInternal: m.isInternal,
        body: m.body,
        createdOn: m.createdOn,
        attachments: found.attachments.filter((a) => a.messageId === m.messageId).map(fileView),
        isNew: isNew(m.createdOn),
      }),
    ),
    ...found.events
      .filter((e) => e.kind !== 'created')
      .map(
        (e): AgentTimelineEntry => ({
          type: 'event',
          id: e.eventId,
          kind: e.kind,
          payload: (e.payload ?? {}) as Record<string, unknown>,
          actorName: e.actorId ? (names.get(e.actorId) ?? null) : null,
          isInternal: e.isInternal,
          createdOn: e.createdOn,
          isNew: isNew(e.createdOn),
        }),
      ),
  ].sort((a, b) => a.createdOn.getTime() - b.createdOn.getTime());
  return {
    ticketId: ticket.ticketId,
    number: ticket.number,
    title: ticket.title,
    description: ticket.description,
    status: ticket.status,
    type: ticket.type,
    impact: ticket.impact,
    priority: ticket.priority,
    priorityConfirmed: ticket.priorityConfirmed,
    visibility: ticket.visibility,
    line: ticket.queue,
    source: ticket.source,
    locale: ticket.locale,
    moduleId: ticket.moduleId,
    createdOn: ticket.createdOn,
    author: { id: ticket.authorId, name: names.get(ticket.authorId) ?? null, email: emails.get(ticket.authorId) ?? null },
    assignee: ticket.assigneeId ? { id: ticket.assigneeId, name: names.get(ticket.assigneeId) ?? null } : null,
    org: orgs.get(ticket.orgId) ?? null,
    sla: {
      firstResponseDueOn: ticket.firstResponseDueOn,
      resolutionDueOn: ticket.resolutionDueOn,
      firstRespondedOn: ticket.firstRespondedOn,
      pausedSince: ticket.slaPausedOn,
      phase: settled ? 'calm' : slaPhase(dueOn, ticket.createdOn, now, cal),
      minutesLeft: dueOn ? workingMinutesBetween(now, dueOn, cal) : null,
    },
    context: ticket.context,
    resolutionType: ticket.resolutionType,
    resolvedVersion: ticket.resolvedVersion,
    snoozedUntil: ticket.snoozedUntil && ticket.snoozedUntil.getTime() > now.getTime() ? ticket.snoozedUntil : null,
    changedSince: seenOn,
    version: ticket.modifiedOn.toISOString(),
    attachments: found.attachments.filter((a) => a.messageId === null).map(fileView),
    timeline,
  };
}

/** Отметка "просмотрено" (UX-A-15). */
export async function markTicketRead(ctx: StaffContext, ticketId: unknown): Promise<void> {
  await markReadTx(ctx.actor, parseInput(z.uuid(), ticketId));
}

export type { SavedFilter } from '../core/agent-queues';
export { QUEUE_KEYS, QUEUE_SORTS, type QueueKey, type QueueSort } from '../core/agent-queue-keys';
