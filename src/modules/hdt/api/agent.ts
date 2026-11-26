import 'server-only';
import { findOrgIds, findUserIds, listAssignableStaff, namesOf, type OrgSummary, orgSummaries, type StaffContext, verifiedEmails } from '@/modules/hdu/api';
import { guestSenders, SERVICE_ORG_ID } from '@/modules/hdu/api/guests';
import { undeliveredMessages } from '@/modules/hdn/api/outbox';
import { isActiveModule, type Tag } from '@/modules/hdr/api';
import { loadSlaConfig } from '@/modules/hdr/api';
import { calendarFor, type SlaPhase, slaPhase } from '../core/sla';
import {
  deleteFilterTx,
  listFiltersTx,
  type QueueKey,
  type QueueSearch,
  queueCountsTx,
  queueSidebarTx,
  queueRowsTx,
  type SavedFilter,
  saveFilterTx,
  THANKS_PAGE_SIZE,
  thanksRowsTx,
} from '../core/agent-queues';
import { markReadTx, readAgentTicketTx } from '../core/agent-ticket';
import { staffTextSearch } from '../core/text-search';
import { timelineLimit } from '../core/timeline';
import { assertCanWrite, assignTx, setModuleTx, setPriorityTx, setStatusTx, setTypeTx, snoozeTx, takeTx } from '../core/agent-actions';
import { HdtError, isHdtError } from '../error';
import { assignInput, moduleInput, numberInput, parseInput, priorityInput, queueInput, savedFilterInput, snoozeInput, statusInput, thanksInput, typeInput, nextInput } from '../input';
import { type AiHandoffReason, type AuthorType, type EventKind, type Impact, INLINE_IMAGE_TYPES, type Priority, type Queue, type ScanStatus, type TicketSource, type TicketStatus, type TicketType, type Visibility } from '../pref';
import { workingMinutesBetween } from '../sla';
import { parseNumber, parseSearch, rejectReasonOf } from '../util';
import * as z from 'zod';
import { wakeAutomation } from '@/modules/hdc/api';
import { wakeOutbox } from '@/modules/hdn/api/outbox';

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
  /** Вернулось из отложенных, и сотрудник с ним ещё ничего не сделал (FR-AG-13). */
  snoozeReturned: boolean;
  clientWaitingSince: Date | null;
  /** Причина передачи помощником: показывается в очереди "После AI" (FR-AG-19). */
  aiHandoffReason: AiHandoffReason | null;
  /** Теги обращения в порядке постановки (FR-AUTO-13). Клиенту не показываются нигде. */
  tags: Tag[];
};

/** Строка поиска: номер и текст как у клиента, плюс организации по названию и ИНН и авторы по имени и адресу. */
async function searchOf(ctx: StaffContext, q: string | undefined): Promise<(QueueSearch & { truncated: boolean }) | 'too_short' | undefined> {
  if (!q) return undefined;
  const parsed = parseSearch(q);
  // Текст короче трёх знаков не ищется (аудит 23.11.2026, находка P9): ни по обращениям, ни по организациям и людям.
  if (parsed.tooShort) return 'too_short';
  // Текст ищет Typesense (план W6, задача 5): опечатки, свёртка письменности, переписка и заметки. Не ответил: прежний путь.
  const [orgIds, authorIds, found] = parsed.text
    ? await Promise.all([findOrgIds(ctx, parsed.text), findUserIds(ctx, parsed.text), staffTextSearch(ctx.actor, parsed.text)])
    : [[], [], null];
  return { number: parsed.number, text: parsed.text, ...(found ? { textIds: found.ids } : {}), orgIds, authorIds, truncated: found?.truncated ?? false };
}

/** Очередь (FR-AG-01), по умолчанию по ближайшему сроку; поиск (FR-AG-10); по 50 строк. */
export async function listQueue(
  ctx: StaffContext,
  input: unknown,
): Promise<{ items: QueueRow[]; hasMore: boolean; nextCursor: string | null; searchTooShort: boolean; searchTruncated: boolean }> {
  const data = parseInput(queueInput, input ?? {});
  const search = await searchOf(ctx, data.q);
  if (search === 'too_short') return { items: [], hasMore: false, nextCursor: null, searchTooShort: true, searchTruncated: false };
  // Ключ листания есть только у сортировки по последнему изменению: по ней листают очередь "Все", где страниц
  // тысячи. Очереди открытых обращений ограничены их числом, там остаётся номер страницы (решение 0040, пункт 5).
  const keyed = data.sort === 'updated';
  if (data.after && !keyed) throw new HdtError('invalid_input');
  const [modifiedKey, ticketId] = (data.after ?? '').split('_') as [string, string | undefined];
  const rows = await queueRowsTx(ctx.actor, {
    queue: data.queue,
    sort: data.sort,
    search,
    tagId: data.tag,
    withTags: true,
    offset: (data.page - 1) * QUEUE_PAGE_SIZE,
    limit: QUEUE_PAGE_SIZE + 1,
    ...(data.after && ticketId ? { after: { modifiedKey, ticketId } } : {}),
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
        snoozeReturned: row.snoozeReturnedOn !== null && row.status !== 'resolved' && row.status !== 'closed',
        clientWaitingSince: row.clientWaitingSince,
        aiHandoffReason: row.aiHandoffReason,
        tags: row.tags,
      };
    }),
    hasMore: rows.length > QUEUE_PAGE_SIZE,
    nextCursor: keyed && rows.length > QUEUE_PAGE_SIZE && page.at(-1) ? `${page.at(-1)?.modifiedKey}_${page.at(-1)?.ticketId}` : null,
    searchTooShort: false,
    // Typesense нашёл больше 250: показаны лучшие совпадения (решение 4).
    searchTruncated: search?.truncated ?? false,
  };
}

export function queueCounts(ctx: StaffContext): Promise<Record<QueueKey, number | null>> {
  return queueCountsTx(ctx.actor);
}

/** Боковая панель страницы очередей одной транзакцией: счётчики, фильтры, число "Неопознанных". */
export function queueSidebar(ctx: StaffContext): Promise<{ counts: Record<QueueKey, number | null>; filters: SavedFilter[]; unidentified: number }> {
  return queueSidebarTx(ctx.actor);
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
      /** Сообщение написано правилом автоматизации: автоматический ответ или заметка (FR-AUTO-11). */
      isAuto: boolean;
      body: string;
      createdOn: Date;
      attachments: AgentFileView[];
      isNew: boolean;
      /** Письмо клиенту об этом ответе не доставлено (решение 21 вехи M4). */
      undelivered: boolean;
      /** Вид сообщения помощника (answer, clarify, handoff, ack); у остальных null. По нему кнопка "Отметить ответ как неверный". */
      aiKind: string | null;
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
  /** Письмо с адреса организации без подтверждения отправителя (решение 15 вехи M4). */
  senderUnconfirmed: boolean;
  /** Автор пока гость из письма: его можно пригласить в организацию обращения (решение 13 вехи M4). */
  guestSender: { address: string } | null;
  assignee: { id: string; name: string | null } | null;
  org: OrgSummary | null;
  sla: { firstResponseDueOn: Date | null; resolutionDueOn: Date | null; firstRespondedOn: Date | null; pausedSince: Date | null; phase: SlaPhase; minutesLeft: number | null };
  context: unknown;
  resolutionType: string | null;
  resolvedVersion: string | null;
  snoozedUntil: Date | null;
  /** Вернулось из отложенных, и сотрудник с ним ещё ничего не сделал (FR-AG-13). */
  snoozeReturned: boolean;
  /** Открытая передача на вторую линию (FR-LINE-06): срок "взять в работу", пока вторая линия не взялась. */
  pickup: { dueOn: Date } | null;
  /** Дубль объединён с основным (решение 4 плана M3). */
  mergedInto: { number: number } | null;
  /** Прошлый визит этого сотрудника (UX-A-15): всё, что позже, отмечено как новое. */
  changedSince: Date | null;
  /** Время последней записи переписки и истории, которую видит агент: по нему ответ узнаёт об изменениях других (FR-AG-12). */
  version: string;
  /** Теги обращения в порядке постановки (FR-AUTO-13). */
  tags: Tag[];
  attachments: AgentFileView[];
  timeline: AgentTimelineEntry[];
  /** Сколько последних записей истории запрошено и есть ли записи раньше них. */
  shown: number;
  hasEarlier: boolean;
};

const PREVIEW_TYPES: readonly string[] = [...INLINE_IMAGE_TYPES, 'application/pdf'];

/** Обращение по номеру (SUP-1042 или 1042) глазами сотрудника. Нет такого: null. */
export async function getAgentTicket(ctx: StaffContext, numberRaw: unknown, opts: { shown?: unknown } = {}): Promise<AgentTicketView | null> {
  const number = typeof numberRaw === 'string' ? parseNumber(numberRaw) : typeof numberRaw === 'number' ? numberRaw : null;
  if (number === null) return null;
  const shown = timelineLimit(opts.shown);
  const found = await readAgentTicketTx(ctx.actor, number, shown);
  if (!found) return null;
  const { ticket, seenOn } = found;
  const people = [ticket.authorId, ticket.assigneeId, ...found.messages.map((m) => m.authorId), ...found.events.map((e) => e.actorId)].filter(
    (id): id is string => id !== null,
  );
  const [names, orgs, emails, config, guests, undelivered] = await Promise.all([
    namesOf(ctx.actor, people),
    orgSummaries(ctx, [ticket.orgId]),
    verifiedEmails(ctx, [ticket.authorId]),
    loadSlaConfig(ctx.actor),
    guestSenders([ticket.authorId]),
    undeliveredMessages(
      ctx.actor,
      found.messages.filter((m) => m.authorType === 'staff' && !m.isInternal).map((m) => m.messageId),
    ),
  ]);
  const guest = guests.get(ticket.authorId);
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
        isAuto: m.isAuto,
        body: m.body,
        createdOn: m.createdOn,
        attachments: found.attachments.filter((a) => a.messageId === m.messageId).map(fileView),
        isNew: isNew(m.createdOn),
        undelivered: undelivered.has(m.messageId),
        aiKind: m.aiKind,
      }),
    ),
    ...found.events
      // Событие действия правила в истории не показывается: о срабатывании говорит одна запись "Правило ..." (FR-AUTO-09).
      .filter((e) => e.kind === 'rule' || (e.payload as Record<string, unknown> | null)?.byRule !== true)
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
    // Порядок задаёт база: время с микросекундами, при равном времени сообщение раньше события.
  ].sort((a, b) => (found.window.order.get(`${a.type === 'message' ? 'm' : 'e'}:${a.id}`) ?? 0) - (found.window.order.get(`${b.type === 'message' ? 'm' : 'e'}:${b.id}`) ?? 0));
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
    author: { id: ticket.authorId, name: names.get(ticket.authorId) ?? null, email: emails.get(ticket.authorId) ?? guest?.address ?? null },
    senderUnconfirmed: ticket.senderUnconfirmed,
    guestSender: guest && ticket.orgId !== SERVICE_ORG_ID ? { address: guest.address } : null,
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
    // У решённого и закрытого пометка не показывается: закрыть обращение могли клиент или система, не снимая её.
    snoozeReturned: ticket.snoozeReturnedOn !== null && ticket.status !== 'resolved' && ticket.status !== 'closed',
    mergedInto: found.mergedIntoNumber !== null ? { number: found.mergedIntoNumber } : null,
    pickup:
      found.transfer && found.transfer.toLine !== 'l1' && !found.transfer.pickedUpOn && found.transfer.pickupDueOn && ticket.queue !== 'l1'
        ? { dueOn: found.transfer.pickupDueOn }
        : null,
    changedSince: seenOn,
    // Последнее, что агент видит на странице: по нему ответ узнаёт об изменениях других (FR-AG-12).
    // Считается по всей истории, а не по показанной части.
    version: new Date(Math.max(ticket.createdOn.getTime(), found.window.latestOn?.getTime() ?? 0)).toISOString(),
    shown,
    hasEarlier: found.window.hasEarlier,
    tags: found.tags,
    attachments: found.attachments.filter((a) => a.messageId === null).map(fileView),
    timeline,
  };
}

/** Отметка "просмотрено" (UX-A-15). */
export async function markTicketRead(ctx: StaffContext, ticketId: unknown): Promise<void> {
  await markReadTx(ctx.actor, parseInput(z.uuid(), ticketId));
}

// --- Действия сотрудника (план M3, задача 7) ---

/** "Взять себе" (FR-AG-02). Уже взял другой: already_taken с его именем. */
export async function takeTicket(ctx: StaffContext, number: unknown): Promise<void> {
  const parsed = parseInput(numberInput, number);
  try {
    await takeTx(ctx.actor, parsed, ctx.user.name);
    await wakeAutomation();
  } catch (error) {
    if (isHdtError(error) && error.code === 'already_taken' && error.holderId) {
      const name = (await namesOf(ctx.actor, [error.holderId])).get(error.holderId);
      throw new HdtError('already_taken', { holderId: error.holderId, holderName: name });
    }
    throw error;
  }
}

/** Назначить коллегу или снять исполнителя (FR-AG-02). Исполнитель только из сотрудников, которые ведут обращения. */
export async function assignTicket(ctx: StaffContext, input: unknown): Promise<void> {
  assertCanWrite(ctx.actor);
  const data = parseInput(assignInput, input);
  const seen = data.seenVersion ? new Date(data.seenVersion) : undefined;
  if (data.assigneeId === null) return assignTx(ctx.actor, data.number, null, seen);
  const assignee = (await listAssignableStaff(ctx)).find((s) => s.userId === data.assigneeId);
  if (!assignee) throw new HdtError('invalid_input');
  await assignTx(ctx.actor, data.number, { id: assignee.userId, name: assignee.name }, seen);
}

/**
 * Действие выполняет макрос (план M8, задача 6): проверки, история и журнал те же, что у ручного действия, но событие
 * предметной области помечается как порождённое правилом, и правила на него не срабатывают (FR-AUTO-07). Признак
 * задаёт только серверный код макроса: из ввода страницы он не читается.
 */
export type StaffActionOptions = { byMacro?: boolean };

/** Статус по таблице 7.2; "Решено" с итогом (FR-AG-09). */
export async function setStatus(ctx: StaffContext, input: unknown, opts: StaffActionOptions = {}): Promise<void> {
  assertCanWrite(ctx.actor);
  const data = parseInput(statusInput, input);
  await setStatusTx(ctx.actor, data.number, data.to, {
    resolution: data.resolution,
    version: data.version,
    seen: data.seenVersion ? new Date(data.seenVersion) : undefined,
    byRule: opts.byMacro === true,
  });
  await wakeOutbox();
  await wakeAutomation();
}

/** Приоритет с причиной (FR-SLA-03). Пустая причина: reason_required. */
export async function setPriority(ctx: StaffContext, input: unknown, opts: StaffActionOptions = {}): Promise<void> {
  assertCanWrite(ctx.actor);
  const data = parseInput(priorityInput, input);
  if (!data.reason) throw new HdtError('reason_required');
  await setPriorityTx(ctx.actor, data.number, data.priority, data.reason, data.seenVersion ? new Date(data.seenVersion) : undefined, { byRule: opts.byMacro === true });
  await wakeAutomation();
}

export async function setTicketType(ctx: StaffContext, input: unknown): Promise<void> {
  assertCanWrite(ctx.actor);
  const data = parseInput(typeInput, input);
  await setTypeTx(ctx.actor, data.number, data.type);
}

/** Модуль из справочника; отключённый и неизвестный отклоняются. */
export async function setTicketModule(ctx: StaffContext, input: unknown): Promise<void> {
  assertCanWrite(ctx.actor);
  const data = parseInput(moduleInput, input);
  if (data.moduleId && !(await isActiveModule(ctx.actor, data.moduleId))) throw new HdtError('invalid_input');
  await setModuleTx(ctx.actor, data.number, data.moduleId);
}

/** Отложить до момента в будущем, не дальше года (FR-AG-13, UX-A-11); null снимает. */
export async function snoozeTicket(ctx: StaffContext, input: unknown): Promise<void> {
  assertCanWrite(ctx.actor);
  const data = parseInput(snoozeInput, input);
  await snoozeTx(ctx.actor, data.number, data.until);
}

export type { SavedFilter } from '../core/agent-queues';
export { QUEUE_KEYS, QUEUE_SORTS, type QueueKey, type QueueSort } from '../core/agent-queue-keys';
export { defaultQueueSort, queueHref, type QueueLocation, type QueueTarget } from '../queue-href';

// --- Благодарности, не открывшие обращение (FR-TK-14; план M3, задача 13) ---

export type ThanksRow = { number: number; orgName: string; body: string; createdOn: Date };

/** Список "Не открыли обращение": благодарности на решённые обращения, новые первыми. */
export async function listThanks(ctx: StaffContext, input: unknown): Promise<{ items: ThanksRow[]; hasMore: boolean }> {
  const page = parseInput(thanksInput, input ?? {}).page;
  const rows = await thanksRowsTx(ctx.actor, page);
  const shown = rows.slice(0, THANKS_PAGE_SIZE);
  const orgs = await orgSummaries(ctx, [...new Set(shown.map((row) => row.orgId))]);
  return {
    items: shown.map((row) => ({ number: row.number, orgName: orgs.get(row.orgId)?.name ?? '', body: row.body, createdOn: row.createdOn })),
    hasMore: rows.length > THANKS_PAGE_SIZE,
  };
}

// --- Следующее обращение очереди (FR-AG-17, UX-A-04; план M3, задача 14) ---

const NEXT_SCAN = 200;

/**
 * Следующее обращение той же очереди и сортировки после afterNumber. Если текущего в очереди уже нет (ответ увёл его
 * из "Новых"), берётся первое другое. Нет такого: null.
 */
export async function nextInQueue(ctx: StaffContext, input: unknown): Promise<number | null> {
  const data = parseInput(nextInput, input);
  const rows = await queueRowsTx(ctx.actor, { queue: data.queue, sort: data.sort, offset: 0, limit: NEXT_SCAN });
  const index = rows.findIndex((row) => row.number === data.afterNumber);
  const next = index >= 0 ? rows[index + 1] : rows.find((row) => row.number !== data.afterNumber);
  return next?.number ?? null;
}
