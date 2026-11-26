import 'server-only';
import { and, asc, eq, sql } from 'drizzle-orm';
import type { Tx } from '@/db/client';
import { emitEventTx, writeAudit } from '@/modules/hdc/api';
import { readSlaConfig } from '@/modules/hdr/api';
import { HdtError } from '../error';
import { AI_REPLY_LIMIT, type AiHandoffReason, type AiPayload, canTransition, type TicketStatus } from '../pref';
import { ticketEvents, ticketMessages, tickets } from '../schema';
import { nextWorkStart } from '../sla';
import { notifyTicketTx } from './notify';
import { calendarFor, refreshSla } from './sla';

// Модуль hdt, слой core: помощник первой линии в обращении (план M5b, задача 3, решения 4, 9, 14, 15; FR-AI-09, 10,
// 14, 15, FR-SLA-04, 10, 11). Действует только система: решения принимает модуль hda по правилам кода, а здесь
// обращение меняется по разрешённым переходам 7.2 одной транзакцией с событием истории, журналом аудита и сроками.
//
// Помощник не меняет приоритет, исполнителя и организацию и не закрывает обращение (FR-AI-10). После передачи он в
// обращении не пишет (FR-AI-09). Ответов не больше трёх.

/** Служебный текст сообщения помощника для поиска сотрудника. Клиенту он не показывается: показ строится из ссылок. */
const SERVICE_BODY: Record<AiPayload['kind'], string> = {
  answer: 'Тез: ответ решением из базы',
  clarify: 'Тез: уточняющий вопрос',
  handoff: 'Тез: передал обращение сотруднику',
  ack: 'Обращение передано сотрудникам',
};

type Locked = { ticketId: string; orgId: string; status: TicketStatus; aiState: string; aiReplyCount: number; priority: string; firstRespondedOn: Date | null };

async function lockAi(tx: Tx, ticketId: string): Promise<Locked> {
  const [row] = await tx
    .select({
      ticketId: tickets.ticketId,
      orgId: tickets.orgId,
      status: tickets.status,
      aiState: tickets.aiState,
      aiReplyCount: tickets.aiReplyCount,
      priority: tickets.priority,
      firstRespondedOn: tickets.firstRespondedOn,
    })
    .from(tickets)
    .where(eq(tickets.ticketId, ticketId))
    .for('update');
  if (!row) throw new HdtError('not_found');
  return row;
}

/** Смена статуса от имени помощника по таблице 7.2: событие истории, журнал, событие правил. */
async function aiStatusTx(tx: Tx, t: Locked, to: TicketStatus): Promise<void> {
  if (!canTransition(t.status, to)) throw new HdtError('transition_refused');
  const diff = { from: t.status, to };
  await tx.insert(ticketEvents).values({ orgId: t.orgId, ticketId: t.ticketId, kind: 'status', actorType: 'ai', payload: diff });
  await writeAudit(tx, { action: 'ticket.status_changed', objectType: 'ticket', objectId: t.ticketId, orgId: t.orgId, diff });
  await emitEventTx(tx, { orgId: t.orgId, ticketId: t.ticketId, kind: 'status_changed', payload: diff });
}

/** Помощник включается в обращении при создании (решение 4): внутреннее событие истории. Уже включён или передан: ничего. */
export async function activateAiTx(tx: Tx, ticketId: string): Promise<boolean> {
  const changed = await tx
    .update(tickets)
    .set({ aiState: 'active' })
    .where(and(eq(tickets.ticketId, ticketId), eq(tickets.aiState, 'none')))
    .returning({ orgId: tickets.orgId, aiState: tickets.aiState });
  const row = changed[0];
  if (!row) return false;
  await tx.insert(ticketEvents).values({ orgId: row.orgId, ticketId, kind: 'ai_state', actorType: 'system', payload: { to: 'active' }, isInternal: true });
  return true;
}

/**
 * Ответ решением или уточняющий вопрос (решения 9, 15). Обращение уходит в "Ждём вашего ответа": срок решения на
 * паузе, пока клиент не отреагирует (FR-SLA-11). Ответ решением останавливает срок первого ответа (FR-SLA-04), вопрос
 * нет. Помощник не активен или ответов уже три: transition_refused.
 */
export async function postAiMessageTx(
  tx: Tx,
  input: {
    ticketId: string;
    payload: Extract<AiPayload, { kind: 'answer' | 'clarify' }>;
    now: Date;
    expectReplyCount?: number;
    /** Заголовок и строки опубликованного решения для письма и Telegram (задача 6). */
    mail?: { solutionTitle: string; lines: string[] };
  },
): Promise<string> {
  const t = await lockAi(tx, input.ticketId);
  if (t.aiState !== 'active' || t.aiReplyCount >= AI_REPLY_LIMIT) throw new HdtError('transition_refused');
  // Второе задание на то же обращение уже ответило, пока это ждало модель: второго ответа нет (решение 5).
  if (input.expectReplyCount !== undefined && t.aiReplyCount !== input.expectReplyCount) throw new HdtError('transition_refused');
  const to: TicketStatus = 'waiting_customer';
  if (t.status !== to) await aiStatusTx(tx, t, to);
  const [message] = await tx
    .insert(ticketMessages)
    .values({ orgId: t.orgId, ticketId: t.ticketId, authorType: 'ai', body: SERVICE_BODY[input.payload.kind], aiPayload: input.payload })
    .returning({ messageId: ticketMessages.messageId });
  await tx.insert(ticketEvents).values({
    orgId: t.orgId,
    ticketId: t.ticketId,
    kind: 'ai_answer',
    actorType: 'ai',
    payload: input.payload.kind === 'answer' ? { kind: 'answer', articleId: input.payload.articleId } : { kind: 'clarify' },
    isInternal: true,
  });
  const answered = input.payload.kind === 'answer' && !t.firstRespondedOn;
  await refreshSla(tx, t.ticketId, input.now, {
    status: to,
    aiReplyCount: t.aiReplyCount + 1,
    clientWaitingSince: null,
    ...(answered ? { firstRespondedOn: input.now } : {}),
  });
  if (input.payload.kind === 'answer' && input.mail)
    await notifyTicketTx(tx, {
      ticketId: t.ticketId,
      kind: 'ai_answer',
      actorUserId: null,
      messageId: message!.messageId,
      aiAnswer: { introId: input.payload.introId, solutionTitle: input.mail.solutionTitle, lines: input.mail.lines, articleNumber: input.payload.articleNumber },
    });
  return message!.messageId;
}

/** Причины, при которых клиент получает шаблонное подтверждение без знака Теза (FR-AI-15, решение 14). */
const ACK_REASONS: readonly AiHandoffReason[] = ['ai_failure', 'ai_disabled', 'ai_limit'];

/**
 * Передача сотруднику (решение 14, FR-AI-09, FR-AI-15, FR-SLA-10) одной транзакцией: состояние и причина, линия l1,
 * статус "Ждём вашего ответа" переходит в "В работе", новое остаётся новым; срок первого ответа сотрудника заново от
 * момента передачи (нарушение до передачи снимается); сообщение помощника о передаче со сроком ответа по календарю;
 * событие ai_handoff для правил, журнал аудита, внутреннее событие истории. Уже передано или помощник не участвует:
 * ничего не меняется (false).
 */
export async function handoffTx(tx: Tx, input: { ticketId: string; reason: AiHandoffReason; questionIds: readonly string[]; now: Date; locale: string }): Promise<boolean> {
  const t = await lockAi(tx, input.ticketId);
  if (t.aiState !== 'active') return false;
  const status: TicketStatus = t.status === 'waiting_customer' ? 'in_progress' : t.status;
  if (status !== t.status) await aiStatusTx(tx, t, status);
  const due = await refreshSla(tx, t.ticketId, input.now, {
    status,
    aiState: 'handed_off',
    aiHandoffReason: input.reason,
    aiHandoffOn: input.now,
    queue: 'l1',
    firstRespondedOn: null,
    firstResponseBreachedOn: null,
  });
  const config = await readSlaConfig(tx);
  const start = nextWorkStart(input.now, calendarFor(config, t.priority as Parameters<typeof calendarFor>[1]));
  const timing = { dueOn: due?.firstResponseDueOn?.toISOString() ?? null, startOn: start?.toISOString() ?? null, locale: input.locale };
  const payload: AiPayload = ACK_REASONS.includes(input.reason)
    ? { kind: 'ack', reason: input.reason, ...timing }
    : { kind: 'handoff', reason: input.reason, questionIds: [...input.questionIds], ...timing };
  await tx.insert(ticketMessages).values({ orgId: t.orgId, ticketId: t.ticketId, authorType: 'ai', body: SERVICE_BODY[payload.kind], aiPayload: payload });
  await tx.insert(ticketEvents).values({ orgId: t.orgId, ticketId: t.ticketId, kind: 'ai_handoff', actorType: 'ai', payload: { reason: input.reason }, isInternal: true });
  await emitEventTx(tx, { orgId: t.orgId, ticketId: t.ticketId, kind: 'ai_handoff', payload: { reason: input.reason, priority: t.priority } });
  await writeAudit(tx, { action: 'ticket.ai_handoff', objectType: 'ticket', objectId: t.ticketId, orgId: t.orgId, diff: { reason: input.reason } });
  // Письмо подтверждения без Теза при выключенном помощнике и пределе (решение 14, FR-AI-15).
  if (input.reason === 'ai_disabled' || input.reason === 'ai_limit')
    await notifyTicketTx(tx, { ticketId: t.ticketId, kind: 'ai_ack', actorUserId: null, aiAck: { dueOn: timing.dueOn, startOn: timing.startOn, timeZone: config.calendar.timeZone } });
  return true;
}

/** Обращение для задачи первой линии: только поля перечня 14.3 и состояние помощника (решения 7, 22). */
export type FirstLineTicket = {
  ticketId: string;
  orgId: string;
  authorId: string;
  number: number;
  title: string;
  description: string;
  source: string;
  type: string;
  priority: string;
  moduleId: string | null;
  errorSignature: string | null;
  locale: string;
  status: TicketStatus;
  aiState: string;
  aiReplyCount: number;
  createdOn: Date;
  /** Публичные сообщения клиента после последнего сообщения помощника, по порядку. Сотрудников, системы и заметок нет. */
  clientMessages: string[];
  /** Есть ли уже сообщение помощника в обращении. */
  hasAiMessage: boolean;
};

export async function firstLineTicketTx(tx: Tx, ticketId: string): Promise<FirstLineTicket | null> {
  const [t] = await tx
    .select({
      ticketId: tickets.ticketId,
      orgId: tickets.orgId,
      authorId: tickets.authorId,
      number: tickets.number,
      title: tickets.title,
      description: tickets.description,
      source: tickets.source,
      type: tickets.type,
      priority: tickets.priority,
      moduleId: tickets.moduleId,
      errorSignature: tickets.errorSignature,
      locale: tickets.locale,
      status: tickets.status,
      aiState: tickets.aiState,
      aiReplyCount: tickets.aiReplyCount,
      createdOn: tickets.createdOn,
    })
    .from(tickets)
    .where(eq(tickets.ticketId, ticketId))
    .limit(1);
  if (!t) return null;
  const rows = await tx
    .select({ authorType: ticketMessages.authorType, body: ticketMessages.body, isInternal: ticketMessages.isInternal })
    .from(ticketMessages)
    .where(eq(ticketMessages.ticketId, ticketId))
    .orderBy(asc(ticketMessages.createdOn), asc(ticketMessages.messageId));
  const lastAi = rows.map((r) => r.authorType).lastIndexOf('ai');
  const clientMessages = rows.slice(lastAi + 1).filter((r) => r.authorType === 'client' && !r.isInternal).map((r) => r.body);
  return { ...t, clientMessages, hasAiMessage: lastAi >= 0 };
}

/**
 * Обращения, где помощник должен был ответить, но молчит (решение 5, слой б): включён, нет ни ответа, ни передачи
 * дольше 60 секунд после создания, или клиент ответил дольше 60 секунд назад, а помощник после этого молчит.
 */
export async function silentAssistantTx(tx: Tx, now: Date, limit: number): Promise<string[]> {
  const rows = await tx.execute<{ ticket_id: string }>(sql`
    select t.ticket_id from hdt_tickets t
     where t.ai_state = 'active'
       and t.status not in ('resolved', 'closed')
       and (
         (not exists (select 1 from hdt_ticket_messages m where m.ticket_id = t.ticket_id and m.author_type = 'ai')
          and t.created_on <= ${now.toISOString()}::timestamptz - interval '60 seconds')
         or (t.last_client_message_on is not null
             and t.last_client_message_on <= ${now.toISOString()}::timestamptz - interval '60 seconds'
             and t.last_client_message_on > coalesce((select max(m.created_on) from hdt_ticket_messages m where m.ticket_id = t.ticket_id and m.author_type = 'ai'), '-infinity'))
       )
     order by t.created_on
     limit ${limit}`);
  return rows.rows.map((r) => r.ticket_id);
}

/** Последнее сообщение помощника в обращении и состояние обращения: проверка нажатия кнопки клиентом. */
export async function lastAiMessageTx(tx: Tx, ticketId: string): Promise<{ messageId: string; payload: AiPayload } | null> {
  const [m] = await tx
    .select({ messageId: ticketMessages.messageId, payload: ticketMessages.aiPayload })
    .from(ticketMessages)
    .where(and(eq(ticketMessages.ticketId, ticketId), eq(ticketMessages.authorType, 'ai')))
    .orderBy(sql`${ticketMessages.createdOn} desc`, sql`${ticketMessages.messageId} desc`)
    .limit(1);
  return m?.payload ? { messageId: m.messageId, payload: m.payload } : null;
}

/** Нажатие клиента под ответом помощника: внутреннее событие истории и журнал аудита (FR-TK-18). */
export async function aiFeedbackEventTx(tx: Tx, input: { ticketId: string; orgId: string; userId: string; choice: string }): Promise<void> {
  await tx.insert(ticketEvents).values({ orgId: input.orgId, ticketId: input.ticketId, kind: 'ai_feedback', actorType: 'client', actorId: input.userId, payload: { choice: input.choice }, isInternal: true });
  await writeAudit(tx, { action: 'ticket.ai_feedback', objectType: 'ticket', objectId: input.ticketId, orgId: input.orgId, diff: { choice: input.choice } });
}

/**
 * "Помогло" (FR-AI-10): "Ждём вашего ответа" переходит в "Решено", помощник в resolved_by_ai, итог "Решено" с
 * выбранным решением. Решено только нажатием клиента: помощник сам обращение не закрывает.
 */
export async function aiResolveTx(tx: Tx, input: { ticketId: string; articleId: string; userId: string; now: Date }): Promise<void> {
  const t = await lockAi(tx, input.ticketId);
  if (t.aiState !== 'active' || !canTransition(t.status, 'resolved')) throw new HdtError('transition_refused');
  const diff = { from: t.status, to: 'resolved' };
  await tx.insert(ticketEvents).values({ orgId: t.orgId, ticketId: t.ticketId, kind: 'status', actorType: 'client', actorId: input.userId, payload: diff });
  await writeAudit(tx, { action: 'ticket.status_changed', objectType: 'ticket', objectId: t.ticketId, orgId: t.orgId, diff });
  await emitEventTx(tx, { orgId: t.orgId, ticketId: t.ticketId, kind: 'status_changed', payload: diff });
  await refreshSla(tx, t.ticketId, input.now, { status: 'resolved', aiState: 'resolved_by_ai', resolvedOn: input.now, resolutionType: 'solved', solutionId: input.articleId });
}
