import 'server-only';
import { type ClientContext, namesOf, otherOrganizationActors } from '@/modules/hdu/api';
import { consumeRateLimit, rateKey, readSetting } from '@/modules/hdc/api';
import { RATE_RULES } from '@/modules/hdc/pref';
import { isActiveModule, loadSlaConfig } from '@/modules/hdr/api';
import { refreshSlaAfterClient } from './api/jobs';
import { confirmTx, rateTx, reopenTx, replyTx, unwatchTx, visibilityTx, watchTx } from './core/actions';
import { createTicketTx, listTicketRows, readTicket, ticketExists } from './core/tickets';
import { HdtError } from './error';
import { createTicketInput, listTicketsInput, numberInput, parseInput, rateInput, reopenInput, replyInput, visibilityInput } from './input';
import {
  ALLOWED_FILES,
  type AuthorType,
  type CsatReason,
  type EventKind,
  INLINE_IMAGE_TYPES,
  MAX_FILES_PER_MESSAGE,
  REOPEN_DAYS_DEFAULT,
  REOPEN_DAYS_SETTING,
  type RejectReason,
  type ScanStatus,
  TICKET_PAGE_SIZE,
  type TicketStatus,
  type TicketType,
  type Impact,
  type Priority,
  type Visibility,
} from './pref';
import { parseNumber, parseSearch, rejectReasonOf, titleFromDescription } from './util';

// Загрузка файлов (задача 5): ссылки в карантин и завершение загрузки.
export { completeUpload, handleUploadRequest, presignUpload } from './api/uploads';
// Скачивание вложений (задача 8).
export { attachmentRedirect, attachmentResponse, DOWNLOAD_LINK_TTL_SEC, handleAttachmentRequest, staffAttachmentRedirect } from './api/attachments';
// Проверка и обход вложений для фонового процесса (задачи 6 и 7): только актор system.
export { needsSlaRefresh, refreshTicketSla, scanAttachment, sweepAttachments } from './api/jobs';
export {
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
  type QueueKey,
  queueCounts,
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
export { formatNumber, parseNumber } from './util';
// Значения для форм и фильтров кабинета: страницы берут модуль только через api.
export {
  allowedStaffTransitions,
  CSAT_REASONS,
  IMPACTS,
  MAX_FILES_PER_MESSAGE,
  PRIORITIES,
  RESOLUTION_TYPES,
  TICKET_STATUSES,
  TICKET_TYPES,
  VISIBILITIES,
} from './pref';
export type { CsatReason, Impact, Priority, ResolutionType, ScanStatus, TicketStatus, TicketType, Visibility } from './pref';
/** Расширения разрешённых файлов (FR-TK-13) для поля выбора файла. */
export const ALLOWED_FILE_EXTENSIONS: readonly string[] = Object.keys(ALLOWED_FILES);

/**
 * Новое обращение клиента (FR-TK-01..05). Организация и автор из контекста, поля организации во входе
 * отбрасываются. Не больше 10 обращений в час на пользователя (раздел 14.5).
 */
export async function createTicket(ctx: ClientContext, input: unknown): Promise<{ number: number }> {
  const data = parseInput(createTicketInput, input);
  if (new Set(data.attachmentIds).size > MAX_FILES_PER_MESSAGE) throw new HdtError('too_many_files');
  if (data.moduleId && !(await isActiveModule(ctx.actor, data.moduleId))) throw new HdtError('invalid_input');
  const limit = await consumeRateLimit(rateKey('ticket-create:user', ctx.actor.userId), RATE_RULES.ticketCreatePerUser);
  if (!limit.allowed) throw new HdtError('rate_limited', { retryAfterSec: limit.retryAfterSec });
  const { number, ticketId } = await createTicketTx(ctx.actor, {
    ...data,
    title: data.title ?? titleFromDescription(data.description),
    attachmentIds: [...new Set(data.attachmentIds)],
  });
  await refreshSlaAfterClient(ticketId);
  return { number };
}

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
export async function listTickets(ctx: ClientContext, input: unknown): Promise<{ items: TicketRow[]; nextCursor: string | null }> {
  const data = parseInput(listTicketsInput, input);
  const search = data.q !== undefined ? parseSearch(data.q) : {};
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
  };
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
export type MessageView = { messageId: string; authorType: AuthorType; authorName: string | null; isMine: boolean; body: string; createdOn: Date; attachments: AttachmentView[] };
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
  csat: { score: number; reason: CsatReason | null; comment: string | null } | null;
  attachments: AttachmentView[];
  messages: MessageView[];
  events: EventView[];
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

/** Срок повторного открытия, дней: настройка tickets.reopen_days, иначе 14 (FR-TK-12). */
export async function reopenDays(): Promise<number> {
  const value = await readSetting(REOPEN_DAYS_SETTING);
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 365 ? value : REOPEN_DAYS_DEFAULT;
}

/** Чей ход (FR-TK-17, UX-C-05): клиента, когда ждём его ответа или подтверждения решения. */
export function turnOf(status: TicketStatus): TicketView['turn'] {
  if (status === 'waiting_customer' || status === 'resolved') return 'client';
  return status === 'closed' ? 'none' : 'support';
}

/** Можно ли ещё открыть закрытое обращение заново. */
export const withinReopen = (closedOn: Date | null, days: number, now: Date = new Date()) =>
  closedOn !== null && now.getTime() - closedOn.getTime() <= days * 86_400_000;

/** Страница обращения по номеру (SUP-1042 или 1042). Чужое, невидимое и несуществующее: пусто, без различия. */
export async function getTicket(ctx: ClientContext, numberRaw: unknown): Promise<TicketView | null> {
  const number = typeof numberRaw === 'string' ? parseNumber(numberRaw) : typeof numberRaw === 'number' ? numberRaw : null;
  if (number === null) return null;
  const found = await readTicket(ctx.actor, number);
  if (!found) return null;
  const { ticket } = found;
  const names = await namesOf(ctx.actor, [ticket.authorId, ...found.messages.map((m) => m.authorId).filter((id): id is string => id !== null)]);
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
    csat: ticket.csatScore !== null ? { score: ticket.csatScore, reason: ticket.csatReason, comment: ticket.csatComment } : null,
    attachments: found.attachments.filter((a) => a.messageId === null).map(fileView),
    messages: found.messages.map((m) => ({
      messageId: m.messageId,
      authorType: m.authorType,
      authorName: m.authorId ? (names.get(m.authorId) ?? null) : null,
      isMine: m.authorId === me,
      body: m.body,
      createdOn: m.createdOn,
      attachments: found.attachments.filter((a) => a.messageId === m.messageId).map(fileView),
    })),
    events: found.events.map((e) => ({ kind: e.kind, actorType: e.actorType, payload: e.payload, createdOn: e.createdOn })),
    turn: turnOf(ticket.status),
    // Часовой пояс календаря поддержки: срок показывается в нём, а не в поясе сервера.
    nextReply: turnOf(ticket.status) === 'support' ? nextReplyOf(ticket, (await loadSlaConfig(ctx.actor)).calendar.timeZone) : null,
    can: {
      reply: ticket.status !== 'closed',
      // Решение 0026, пункт 21: подтверждают автор и администратор клиента, открыть снова может любой, кто видит,
      // оценивает только автор.
      confirm: ticket.status === 'resolved' && (isMine || ctx.actor.orgRole === 'client_admin'),
      reopen: ticket.status === 'resolved' || (ticket.status === 'closed' && withinReopen(ticket.closedOn, days)),
      rate: ticket.status === 'closed' && ticket.csatScore === null && isMine,
      changeVisibility: isMine || ctx.actor.orgRole === 'client_admin',
      watch: ticket.visibility === 'org' && !isMine,
    },
  };
}

// --- Действия клиента (FR-TK-08..12). Отказ: HdtError с кодом из error.ts. ---

/** Ответ на портале с файлами (FR-TK-08). Не больше 60 ответов в час на пользователя. */
export async function replyToTicket(ctx: ClientContext, input: unknown): Promise<void> {
  const data = parseInput(replyInput, input);
  const ids = [...new Set(data.attachmentIds)];
  if (ids.length > MAX_FILES_PER_MESSAGE) throw new HdtError('too_many_files');
  const limit = await consumeRateLimit(rateKey('ticket-reply:user', ctx.actor.userId), RATE_RULES.ticketReplyPerUser);
  if (!limit.allowed) throw new HdtError('rate_limited', { retryAfterSec: limit.retryAfterSec });
  await refreshSlaAfterClient(await replyTx(ctx.actor, data.number, data.body, ids));
}

/** Общий предел действий с обращением на пользователя (вторая проверка M2): каждое пишет событие и журнал. */
async function consumeAction(ctx: ClientContext): Promise<void> {
  const limit = await consumeRateLimit(rateKey('ticket-action:user', ctx.actor.userId), RATE_RULES.ticketActionPerUser);
  if (!limit.allowed) throw new HdtError('rate_limited', { retryAfterSec: limit.retryAfterSec });
}

/** "Решение подошло" (FR-TK-10). */
export async function confirmResolution(ctx: ClientContext, number: unknown): Promise<void> {
  const parsed = parseInput(numberInput, number);
  await consumeAction(ctx);
  await confirmTx(ctx.actor, parsed);
}

/** Открыть заново (FR-TK-12): решённое или закрытое в пределах срока из настройки. */
export async function reopenTicket(ctx: ClientContext, input: unknown): Promise<void> {
  const data = parseInput(reopenInput, input);
  await consumeAction(ctx);
  await refreshSlaAfterClient(await reopenTx(ctx.actor, data.number, await reopenDays(), data.body));
}

/** Оценка закрытого обращения (FR-TK-11). */
export async function rateTicket(ctx: ClientContext, input: unknown): Promise<void> {
  const data = parseInput(rateInput, input);
  await consumeAction(ctx);
  await rateTx(ctx.actor, data.number, { score: data.score, reason: data.reason, comment: data.comment });
}

/** Видимость обращения (FR-TK-04). */
export async function setTicketVisibility(ctx: ClientContext, input: unknown): Promise<void> {
  const data = parseInput(visibilityInput, input);
  await consumeAction(ctx);
  await visibilityTx(ctx.actor, data.number, data.visibility);
}

/** Подписка на обращение коллеги (FR-TK-09). */
export async function watchTicket(ctx: ClientContext, number: unknown): Promise<void> {
  const parsed = parseInput(numberInput, number);
  await consumeAction(ctx);
  await watchTx(ctx.actor, parsed);
}

export async function unwatchTicket(ctx: ClientContext, number: unknown): Promise<void> {
  const parsed = parseInput(numberInput, number);
  await consumeAction(ctx);
  await unwatchTx(ctx.actor, parsed);
}
