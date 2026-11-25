import 'server-only';
import { type ClientContext, namesOf, otherOrganizationActors } from '@/modules/hdu/api';
import { consumeRateLimit, rateKey, recordTicketSignature, wakeAutomation } from '@/modules/hdc/api';
import { RATE_RULES } from '@/modules/hdc/pref';
import { isActiveModule, loadSlaConfig } from '@/modules/hdr/api';
import { refreshSlaAfterClient } from './api/jobs';
import { confirmTx, rateTx, reopenDays, reopenTx, replyTx, unwatchTx, visibilityTx, watchTx } from './core/actions';
import { createTicketTx, listTicketRows, readTicket, ticketExists } from './core/tickets';
import { HdtError } from './error';
import { createTicketInput, listTicketsInput, modeBContext, numberInput, parseInput, rateInput, reopenInput, replyInput, visibilityInput, widgetTicketInput } from './input';
import type { TicketContext } from './schema';
import {
  ALLOWED_FILES,
  type AuthorType,
  type CsatReason,
  type EventKind,
  INLINE_IMAGE_TYPES,
  MAX_FILES_PER_MESSAGE,
  type RejectReason,
  type ScanStatus,
  TICKET_PAGE_SIZE,
  type TicketStatus,
  type TicketType,
  type Impact,
  type Priority,
  type Visibility,
} from './pref';
import { timelineLimit } from './core/timeline';
import { parseNumber, parseSearch, rejectReasonOf, titleFromDescription } from './util';
import { wakeOutbox } from '@/modules/hdn/api/outbox';

// Загрузка файлов (задача 5): ссылки в карантин и завершение загрузки.
export { completeStaffUpload, completeUpload, handleUploadRequest, presignStaffUpload, presignUpload } from './api/uploads';
// Обращение от имени клиента (план M3, задача 12).
export { createTicketForClient } from './api/staff-create';
// Объединение дублей и массовые действия (план M3, задача 11).
export { bulkAction, type BulkResult, mergeTicket } from './api/bulk';
// Передача между линиями (план M3, задача 9).
export { returnToL1, transferToL2 } from './api/lines';
export { csatLinkNumber, rateByLink, type RateByLinkResult } from './api/csat-link';
// Ответ, заметка, черновик и присутствие сотрудника (план M3, задача 8).
export { type ChangeSummary, listPresence, loadDraft, postStaffMessage, type PresenceEntry, saveDraft, syncPresence, touchPresence } from './api/agent-messages';
// Скачивание вложений (задача 8).
export { attachmentRedirect, attachmentResponse, DOWNLOAD_LINK_TTL_SEC, handleAttachmentRequest, staffAttachmentRedirect } from './api/attachments';
// Проверка и обход вложений для фонового процесса (задачи 6 и 7): только актор system.
export { applyGuestMerges, type MinuteResult, needsSlaRefresh, refreshTicketSla, scanAttachment, sweepAttachments, ticketsMinute } from './api/jobs';
// Теги на обращении (план M8, задача 1).
export { addTicketTag, removeTicketTag, tagUsage } from './api/tags';
export {
  BREAKDOWN_PAGE,
  type Breakdown,
  type BreakdownItem,
  buildCsv,
  canReviewCsat,
  canSeeBreakdown,
  type ChannelRow,
  CSAT_REVIEW_MAX,
  CSV_MAX_ROWS,
  exportFileName,
  exportMetrics,
  getMetrics,
  getMetricsBreakdown,
  type LineRow,
  type LowRating,
  LOW_RATINGS_LIMIT,
  METRICS_MAX_DAYS,
  METRICS_PRESETS,
  METRICS_REPORTS,
  METRICS_ROW_CAP,
  type MetricsExport,
  type MetricsReport,
  type MetricsView,
  saveCsatReview,
  splitMinutes,
  TICKET_CHANNELS,
  type TicketChannel,
} from './api/metrics';
export { type PickupMinutes, readPickup, readTimings, savePickup, saveTimings, type Timings, TIMINGS_DEFAULT } from './api/timings';
export {
  bindTicket,
  inviteSender,
  listUnidentified,
  markNotClient,
  markSpam,
  type UnidentifiedItem,
  unidentifiedCount,
} from './api/unidentified';
export {
  nextInQueue,
  listThanks,
  type ThanksRow,
  deleteFilter,
  listFilters,
  assignTicket,
  getAgentTicket,
  type AgentFileView,
  type AgentTicketView,
  type AgentTimelineEntry,
  listQueue,
  markTicketRead,
  QUEUE_KEYS,
  QUEUE_PAGE_SIZE,
  QUEUE_SORTS,
  defaultQueueSort,
  queueHref,
  type QueueLocation,
  type QueueTarget,
  type QueueKey,
  queueCounts,
  queueSidebar,
  type QueueRow,
  type QueueSort,
  type SavedFilter,
  saveFilter,
  setPriority,
  setStatus,
  setTicketModule,
  setTicketType,
  snoozeTicket,
  takeTicket,
} from './api/agent';
export { SWEEP_BATCH } from './pref';
// Расчёт момента "отложить до" для формы рабочего места (UX-A-11).
export { type SnoozePreset, snoozeTarget, zonedToDate } from './sla';

// Модуль hdt (обращения), слой api: точки входа для страниц, обработчиков и других модулей.
// Каждая функция принимает проверенный контекст клиента и разбирает вход схемой (ТЗ 9.4, правило 7).

export { HDT_ERROR_CODES, type HdtErrorCode, HdtError, isHdtError } from './error';
export { earlierLink, formatNumber, parseNumber } from './util';
// Значения для форм и фильтров кабинета: страницы берут модуль только через api.
export {
  allowedStaffTransitions,
  CSAT_REASONS,
  DEVELOPMENT_ROLES,
  IMPACTS,
  MAX_FILES_PER_MESSAGE,
  PRIORITIES,
  RESOLUTION_TYPES,
  TICKET_STATUSES,
  TICKET_TYPES,
  TIMELINE_PAGE,
  TRANSFER_REASONS,
  TRANSFERABLE_STATUSES,
  VISIBILITIES,
} from './pref';
export type { CsatReason, Impact, Priority, ResolutionType, ScanStatus, TicketStatus, TicketType, Visibility } from './pref';
/** Расширения разрешённых файлов (FR-TK-13) для поля выбора файла. */
export const ALLOWED_FILE_EXTENSIONS: readonly string[] = Object.keys(ALLOWED_FILES);

/**
 * Достаточно актора клиента: так операции клиента вызывают и страницы портала (сессия), и виджет (токен виджета,
 * план M6). Организация и автор всегда из актора.
 */
type ClientActorContext = Pick<ClientContext, 'actor'>;

/**
 * Новое обращение клиента (FR-TK-01..05). Организация и автор из контекста, поля организации во входе
 * отбрасываются. Не больше 10 обращений в час на пользователя (раздел 14.5).
 */
export async function createTicket(ctx: ClientActorContext, input: unknown): Promise<{ number: number; ticketId: string }> {
  const data = parseInput(createTicketInput, input);
  if (new Set(data.attachmentIds).size > MAX_FILES_PER_MESSAGE) throw new HdtError('too_many_files');
  if (data.moduleId && !(await isActiveModule(ctx.actor, data.moduleId))) throw new HdtError('invalid_input');
  const limit = await consumeRateLimit(rateKey('ticket-create:user', ctx.actor.userId), RATE_RULES.ticketCreatePerUser);
  if (!limit.allowed) throw new HdtError('rate_limited', { retryAfterSec: limit.retryAfterSec });
  // Режим B виджета (план M6, задача 8; решения 11 и 12): форма открыта из загрузчика. Источник widget_web и контекст
  // из подсказок; платформы нет, её знает только проверенный токен. Признак влияет только на показатели.
  const { widget, context: rawContext, ...fields } = data;
  const context: TicketContext | null = widget ? modeBContext(rawContext) : null;
  const hasContext = context !== null && Object.keys(context).length > 0;
  const { number, ticketId } = await createTicketTx(ctx.actor, {
    ...fields,
    title: data.title ?? titleFromDescription(data.description),
    attachmentIds: [...new Set(data.attachmentIds)],
    ...(widget && { source: 'widget_web' as const, context: hasContext ? context : null }),
  });
  await refreshSlaAfterClient(ticketId);
  // Сигнатура ошибки из описания (план M5, задача 8): считает сервер от имени системы до разбора правил, клиент её
  // не задаёт. У режима B, как в панели виджета, из кода и текста ошибки (решение 0055). Сбой сигнатуры обращение не отменяет.
  await recordTicketSignature({
    ticketId,
    orgId: ctx.actor.orgId,
    authorId: ctx.actor.userId,
    description: data.description,
    context: hasContext ? { errorCode: context.errorCode, errorText: context.errorText } : null,
    moduleId: data.moduleId ?? null,
  });
  // Письмо с номером уже в очереди (FR-NT-09): отправка будится после фиксации. Событие для правил тоже записано.
  await wakeOutbox();
  await wakeAutomation();
  return { number, ticketId };
}

/**
 * Обращение из виджета (план M6, задача 5; решения 10, 11 и 12). Та же операция, что на портале: проверка модуля,
 * предел 10 обращений в час на пользователя, сроки, сигнатура, письмо и правила. Источник по платформе проверенного
 * токена: web даёт widget_web, android и ios widget_mobile. Платформа в контексте тоже из токена, а не из подсказок.
 * Сигнатура считается по коду и тексту ошибки контекста (решение 0055), модуль в неё не входит (решение 10).
 */
export async function createWidgetTicket(ctx: ClientActorContext, input: unknown, opts: { platform: 'web' | 'android' | 'ios' }): Promise<{ number: number; ticketId: string }> {
  const data = parseInput(widgetTicketInput, input);
  if (new Set(data.attachmentIds).size > MAX_FILES_PER_MESSAGE) throw new HdtError('too_many_files');
  if (data.moduleId && !(await isActiveModule(ctx.actor, data.moduleId))) throw new HdtError('invalid_input');
  const limit = await consumeRateLimit(rateKey('ticket-create:user', ctx.actor.userId), RATE_RULES.ticketCreatePerUser);
  if (!limit.allowed) throw new HdtError('rate_limited', { retryAfterSec: limit.retryAfterSec });
  const context: TicketContext = { ...stripUndefined(data.context), platform: opts.platform };
  const { number, ticketId } = await createTicketTx(ctx.actor, {
    description: data.description,
    title: titleFromDescription(data.description),
    type: data.type,
    impact: data.impact,
    visibility: data.visibility,
    moduleId: data.moduleId,
    attachmentIds: [...new Set(data.attachmentIds)],
    locale: data.locale,
    source: opts.platform === 'web' ? 'widget_web' : 'widget_mobile',
    context,
  });
  await refreshSlaAfterClient(ticketId);
  await recordTicketSignature({
    ticketId,
    orgId: ctx.actor.orgId,
    authorId: ctx.actor.userId,
    description: data.description,
    context: { errorCode: context.errorCode, errorText: context.errorText },
    moduleId: data.moduleId ?? null,
  });
  await wakeOutbox();
  await wakeAutomation();
  return { number, ticketId };
}

const stripUndefined = <T extends Record<string, unknown>>(value: T): Partial<T> =>
  Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as Partial<T>;

// --- Список и страница (FR-TK-06, FR-TK-07, FR-TK-17) ---

export type TicketRow = { number: number; title: string; status: TicketStatus; type: TicketType; visibility: Visibility; isMine: boolean; modifiedOn: Date };

const encodeCursor = (row: { modifiedOnText: string; ticketId: string }) => Buffer.from(JSON.stringify([row.modifiedOnText, row.ticketId])).toString('base64url');

function decodeCursor(cursor: string): { modifiedOn: string; ticketId: string } {
  try {
    const [modifiedOn, ticketId] = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as [unknown, unknown];
    // Время изменения текстом базы: 2026-11-21 10:12:30.123456+00.
    if (typeof modifiedOn !== 'string' || !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d{1,6})?[+-]\d{2}(:\d{2})?$/.test(modifiedOn)) throw new Error('cursor');
    if (typeof ticketId !== 'string' || !/^[0-9a-f-]{36}$/.test(ticketId)) throw new Error('cursor');
    return { modifiedOn, ticketId };
  } catch {
    throw new HdtError('invalid_input');
  }
}

/**
 * Обращения клиента: организации (видимые ему) или только свои, с фильтром по статусу и типу и поиском по
 * номеру или тексту темы и описания. По 20 строк, новые изменения первыми, курсор на следующую страницу.
 */
export async function listTickets(ctx: ClientActorContext, input: unknown): Promise<{ items: TicketRow[]; nextCursor: string | null; searchTooShort: boolean; searchLimited: boolean }> {
  const data = parseInput(listTicketsInput, input);
  const search = data.q !== undefined ? parseSearch(data.q) : { tooShort: false };
  // Текст короче трёх знаков не ищется: список пуст, страница просит уточнить запрос (аудит 23.11.2026, находка P9).
  if (search.tooShort) return { items: [], nextCursor: null, searchTooShort: true, searchLimited: false };
  // Поиск по тексту идёт по общему индексу: время ответа зависит от совпадений во всей базе. Предел частоты не даёт
  // перебирать шаблоны ради замера времени (решение 0041, пункт 9). Список без поиска и поиск по номеру не считаются.
  if (search.text && !(await searchAllowed(ctx.actor))) return { items: [], nextCursor: null, searchTooShort: false, searchLimited: true };
  const rows = await listTicketRows(ctx.actor, {
    mineOnly: data.scope === 'mine',
    status: data.status,
    type: data.type,
    // Цифры без приставки ищутся и в тексте: "500" это и номер обращения, и код ошибки в описании.
    number: search.number,
    text: search.text,
    after: data.cursor ? decodeCursor(data.cursor) : undefined,
  });
  const page = rows.slice(0, TICKET_PAGE_SIZE);
  const last = page.at(-1);
  return {
    items: page.map((row) => ({
      number: row.number,
      title: row.title,
      status: row.status,
      type: row.type,
      visibility: row.visibility,
      isMine: row.authorId === ctx.actor.userId,
      modifiedOn: row.modifiedOn,
    })),
    nextCursor: rows.length > TICKET_PAGE_SIZE && last ? encodeCursor(last) : null,
    searchTooShort: false,
    searchLimited: false,
  };
}

/** Учитывает поиск по тексту на пользователя и на организацию. Оба счётчика считают каждую попытку. */
async function searchAllowed(actor: ClientContext['actor']): Promise<boolean> {
  const [user, org] = await Promise.all([
    consumeRateLimit(rateKey('ticket-search:user', actor.userId), RATE_RULES.ticketSearchPerUser),
    consumeRateLimit(rateKey('ticket-search:org', actor.orgId), RATE_RULES.ticketSearchPerOrg),
  ]);
  return user.allowed && org.allowed;
}

export type AttachmentView = {
  attachmentId: string;
  fileName: string;
  mime: string;
  size: number;
  scanStatus: ScanStatus;
  /** Почему файл не принят, если это можно назвать клиенту (решение 0027, пункт 20). */
  rejectReason: RejectReason | null;
  isImage: boolean;
  isMine: boolean;
};
/** isAuto: автоматический ответ правила автоматизации (FR-AUTO-11): страница помечает его подписью. */
export type MessageView = { messageId: string; authorType: AuthorType; authorName: string | null; isMine: boolean; isAuto: boolean; body: string; createdOn: Date; attachments: AttachmentView[] };
export type EventView = { kind: EventKind; actorType: AuthorType; payload: Record<string, unknown>; createdOn: Date };
export type TicketActions = { reply: boolean; confirm: boolean; reopen: boolean; rate: boolean; changeVisibility: boolean; watch: boolean };
export type TicketView = {
  number: number;
  title: string;
  description: string;
  status: TicketStatus;
  type: TicketType;
  impact: Impact;
  priority: Priority;
  visibility: Visibility;
  createdOn: Date;
  closedOn: Date | null;
  author: { id: string; name: string | null };
  isMine: boolean;
  watching: boolean;
  relatedNumber: number | null;
  /** Обращение объединено с основным (решение 4 плана M3): номер, только если основное видно клиенту. */
  mergedInto: { number: number } | null;
  merged: boolean;
  /** Обращение завёл сотрудник по звонку клиента (FR-AG-08). */
  createdByStaff: boolean;
  csat: { score: number; reason: CsatReason | null; comment: string | null } | null;
  attachments: AttachmentView[];
  messages: MessageView[];
  events: EventView[];
  /** Сколько последних записей истории запрошено и есть ли записи раньше них. */
  shown: number;
  hasEarlier: boolean;
  turn: 'client' | 'support' | 'none';
  /** Срок, который поддержка обещает клиенту сейчас (FR-SLA-08): первый ответ или решение. На ходу клиента пусто. */
  nextReply: { kind: 'first_response' | 'resolution'; at: Date; timeZone: string } | null;
  can: TicketActions;
};

/** Срок следующего ответа для клиента: до первого ответа сам первый ответ, после него срок решения. */
function nextReplyOf(
  ticket: { status: TicketStatus; firstRespondedOn: Date | null; firstResponseDueOn: Date | null; resolutionDueOn: Date | null },
  timeZone: string,
): TicketView['nextReply'] {
  if (turnOf(ticket.status) !== 'support') return null;
  if (!ticket.firstRespondedOn) return ticket.firstResponseDueOn ? { kind: 'first_response', at: ticket.firstResponseDueOn, timeZone } : null;
  return ticket.resolutionDueOn ? { kind: 'resolution', at: ticket.resolutionDueOn, timeZone } : null;
}

/**
 * Обращение по номеру в другой организации пользователя (UX-C-06): ссылка из письма могла вести туда, а активна
 * другая организация. Проверка идёт от имени пользователя в той организации, под её политиками RLS: подсказка
 * появляется, только если после переключения обращение ему будет видно. Иначе пусто, как "не найдено".
 */
export async function findTicketInOtherOrganizations(ctx: ClientContext, numberRaw: unknown): Promise<{ orgId: string; orgName: string } | null> {
  const number = typeof numberRaw === 'string' ? parseNumber(numberRaw) : null;
  if (number === null) return null;
  // Только наличие: страница другой организации здесь не нужна, сообщения и файлы не читаются.
  for (const other of await otherOrganizationActors(ctx))
    if (await ticketExists(other.actor, number)) return { orgId: other.orgId, orgName: other.name };
  return null;
}

export { reopenDays };

/** Чей ход (FR-TK-17, UX-C-05): клиента, когда ждём его ответа или подтверждения решения. */
export function turnOf(status: TicketStatus): TicketView['turn'] {
  if (status === 'waiting_customer' || status === 'resolved') return 'client';
  return status === 'closed' ? 'none' : 'support';
}

/** Можно ли ещё открыть закрытое обращение заново. */
export const withinReopen = (closedOn: Date | null, days: number, now: Date = new Date()) =>
  closedOn !== null && now.getTime() - closedOn.getTime() <= days * 86_400_000;

/** Страница обращения по номеру (SUP-1042 или 1042). Чужое, невидимое и несуществующее: пусто, без различия. */
export async function getTicket(ctx: ClientActorContext, numberRaw: unknown, opts: { shown?: unknown } = {}): Promise<TicketView | null> {
  const number = typeof numberRaw === 'string' ? parseNumber(numberRaw) : typeof numberRaw === 'number' ? numberRaw : null;
  if (number === null) return null;
  const shown = timelineLimit(opts.shown);
  const found = await readTicket(ctx.actor, number, shown);
  if (!found) return null;
  const { ticket } = found;
  // Имена только людей клиента: ответ сотрудника подписан "Поддержка Smartup", имя сотрудника клиенту не уходит (FR-LINE-07).
  const clientAuthors = found.messages.filter((m) => m.authorType === 'client' && m.authorId !== null).map((m) => m.authorId as string);
  const names = await namesOf(ctx.actor, [ticket.authorId, ...clientAuthors]);
  const me = ctx.actor.userId;
  const fileView = (a: (typeof found.attachments)[number]): AttachmentView => ({
    attachmentId: a.attachmentId,
    fileName: a.fileName,
    mime: a.mime,
    size: a.size,
    scanStatus: a.scanStatus,
    rejectReason: a.scanStatus === 'rejected' ? rejectReasonOf(a.scanSignature) : null,
    isImage: INLINE_IMAGE_TYPES.includes(a.mime),
    isMine: a.uploaderId === me,
  });
  const isMine = ticket.authorId === me;
  const days = await reopenDays();
  return {
    number: ticket.number,
    title: ticket.title,
    description: ticket.description,
    status: ticket.status,
    type: ticket.type,
    impact: ticket.impact,
    priority: ticket.priority,
    visibility: ticket.visibility,
    createdOn: ticket.createdOn,
    closedOn: ticket.closedOn,
    author: { id: ticket.authorId, name: names.get(ticket.authorId) ?? null },
    isMine,
    watching: found.watching,
    relatedNumber: found.relatedNumber,
    mergedInto: found.mergedIntoNumber !== null ? { number: found.mergedIntoNumber } : null,
    merged: ticket.mergedIntoId !== null,
    createdByStaff: ticket.source === 'staff',
    csat: ticket.csatScore !== null ? { score: ticket.csatScore, reason: ticket.csatReason, comment: ticket.csatComment } : null,
    attachments: found.attachments.filter((a) => a.messageId === null).map(fileView),
    messages: found.messages.map((m) => ({
      messageId: m.messageId,
      authorType: m.authorType,
      authorName: m.authorType === 'client' && m.authorId ? (names.get(m.authorId) ?? null) : null,
      isMine: m.authorId === me,
      isAuto: m.isAuto,
      body: m.body,
      createdOn: m.createdOn,
      attachments: found.attachments.filter((a) => a.messageId === m.messageId).map(fileView),
    })),
    events: found.events.map((e) => ({ kind: e.kind, actorType: e.actorType, payload: e.payload, createdOn: e.createdOn })),
    shown,
    hasEarlier: found.hasEarlier,
    turn: turnOf(ticket.status),
    // Часовой пояс календаря поддержки: срок показывается в нём, а не в поясе сервера.
    nextReply: turnOf(ticket.status) === 'support' ? nextReplyOf(ticket, (await loadSlaConfig(ctx.actor)).calendar.timeZone) : null,
    can: {
      reply: ticket.status !== 'closed',
      // Решение 0026, пункт 21: подтверждают автор и администратор клиента, открыть снова может любой, кто видит,
      // оценивает только автор.
      confirm: ticket.status === 'resolved' && (isMine || ctx.actor.orgRole === 'client_admin'),
      reopen: ticket.mergedIntoId === null && (ticket.status === 'resolved' || (ticket.status === 'closed' && withinReopen(ticket.closedOn, days))),
      rate: ticket.status === 'closed' && ticket.csatScore === null && isMine,
      changeVisibility: isMine || ctx.actor.orgRole === 'client_admin',
      watch: ticket.visibility === 'org' && !isMine,
    },
  };
}

// --- Действия клиента (FR-TK-08..12). Отказ: HdtError с кодом из error.ts. ---

/** Ответ на портале с файлами (FR-TK-08). Не больше 60 ответов в час на пользователя. */
export async function replyToTicket(ctx: ClientActorContext, input: unknown): Promise<void> {
  const data = parseInput(replyInput, input);
  const ids = [...new Set(data.attachmentIds)];
  if (ids.length > MAX_FILES_PER_MESSAGE) throw new HdtError('too_many_files');
  const limit = await consumeRateLimit(rateKey('ticket-reply:user', ctx.actor.userId), RATE_RULES.ticketReplyPerUser);
  if (!limit.allowed) throw new HdtError('rate_limited', { retryAfterSec: limit.retryAfterSec });
  await refreshSlaAfterClient(await replyTx(ctx.actor, data.number, data.body, ids));
  await wakeAutomation();
}

/** Общий предел действий с обращением на пользователя (вторая проверка M2): каждое пишет событие и журнал. */
async function consumeAction(ctx: ClientActorContext): Promise<void> {
  const limit = await consumeRateLimit(rateKey('ticket-action:user', ctx.actor.userId), RATE_RULES.ticketActionPerUser);
  if (!limit.allowed) throw new HdtError('rate_limited', { retryAfterSec: limit.retryAfterSec });
}

/** "Решение подошло" (FR-TK-10). */
export async function confirmResolution(ctx: ClientActorContext, number: unknown): Promise<void> {
  const parsed = parseInput(numberInput, number);
  await consumeAction(ctx);
  await confirmTx(ctx.actor, parsed);
  await wakeAutomation();
}

/** Открыть заново (FR-TK-12): решённое или закрытое в пределах срока из настройки. */
export async function reopenTicket(ctx: ClientActorContext, input: unknown): Promise<void> {
  const data = parseInput(reopenInput, input);
  await consumeAction(ctx);
  await refreshSlaAfterClient(await reopenTx(ctx.actor, data.number, await reopenDays(), data.body));
  await wakeAutomation();
}

/** Оценка закрытого обращения (FR-TK-11). */
export async function rateTicket(ctx: ClientActorContext, input: unknown): Promise<void> {
  const data = parseInput(rateInput, input);
  await consumeAction(ctx);
  await rateTx(ctx.actor, data.number, { score: data.score, reason: data.reason, comment: data.comment });
  await wakeAutomation();
}

/** Видимость обращения (FR-TK-04). */
export async function setTicketVisibility(ctx: ClientActorContext, input: unknown): Promise<void> {
  const data = parseInput(visibilityInput, input);
  await consumeAction(ctx);
  await visibilityTx(ctx.actor, data.number, data.visibility);
}

/** Подписка на обращение коллеги (FR-TK-09). */
export async function watchTicket(ctx: ClientActorContext, number: unknown): Promise<void> {
  const parsed = parseInput(numberInput, number);
  await consumeAction(ctx);
  await watchTx(ctx.actor, parsed);
}

export async function unwatchTicket(ctx: ClientActorContext, number: unknown): Promise<void> {
  const parsed = parseInput(numberInput, number);
  await consumeAction(ctx);
  await unwatchTx(ctx.actor, parsed);
}
