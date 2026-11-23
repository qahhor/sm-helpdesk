import 'server-only';
import { and, eq, sql } from 'drizzle-orm';
import type { Tx } from '@/db/client';
import { channelsForMany, emailAllowed, type NotificationKind, notifyTx, type PrefKind } from '@/modules/hdn/api/notifications';
import { enqueueTx, TELEGRAM_TEMPLATES } from '@/modules/hdn/api/outbox';
import { organizationName, replyRoles } from '@/modules/hdu/api/recipients';
import type { TicketStatus, Visibility } from '../pref';
import { ticketMessages, tickets, ticketWatchers } from '../schema';

// Модуль hdt, слой core: кто получает письмо и уведомление по событию обращения (FR-NT-01, FR-NT-04, FR-NT-10;
// решение 6 вехи M4). Вызывается в транзакции действия: письмо и уведомление появляются вместе с изменением
// или не появляются вовсе (FR-NT-09). Отправку будит слой api после фиксации (wakeOutbox).
//
// Каналы клиента (решения 3 и 4 вехи M4b): о своих обращениях хотя бы один внешний канал (почта или Telegram),
// об обращениях коллег по настройке. В Telegram уходит короткое сообщение без текста ответа (FR-NT-15).
// Тот, кто действовал, о своём действии не уведомляется. В письмо "ответ" идёт только публичное сообщение
// сотрудника этого обращения: внутренние заметки и чужие обращения в письма не попадают.

export type TicketNotice = {
  ticketId: string;
  kind:
    | 'created'
    | 'staff_reply'
    | 'status'
    | 'resolved'
    | 'merged'
    | 'auto_closed'
    | 'waiting_reminder'
    | 'client_reply'
    | 'unidentified_ack'
    | 'mention'
    | 'sla_breach'
    | 'snooze_returned'
    | 'update_due';
  /** Кто действовал: он не получает уведомления о своём действии. Система: null. */
  actorUserId: string | null;
  messageId?: string;
  to?: TicketStatus;
  /** Обращение создано письмом (задача 10): в письме подсказка ответить на него. */
  viaEmail?: boolean;
  mergedInto?: number;
  closeInDays?: number;
  /** Упоминание: кого упомянули и кто написал заметку. */
  mentioned?: string[];
  authorName?: string;
  /** Нарушение срока: какой срок и руководители линии обращения. */
  breach?: 'first_response' | 'resolution';
  leads?: string[];
};

/** Смены статуса, о которых клиенту уходит письмо (решение 6). "Решено" идёт отдельным письмом. */
const STATUS_MAILS = new Set<TicketStatus>(['waiting_customer', 'in_development', 'closed']);
const CLIENT_SETTINGS_PATH = '/settings';
const STAFF_SETTINGS_PATH = '/agent/account';

type TicketInfo = { number: number; title: string; locale: string; authorId: string; assigneeId: string | null; orgId: string; visibility: Visibility };
type Mail = Parameters<typeof enqueueTx>[1]['payload'];

async function people(tx: Tx, ticketId: string, ticket: TicketInfo, actorUserId: string | null): Promise<string[]> {
  const watchers = await tx.select({ userId: ticketWatchers.userId }).from(ticketWatchers).where(eq(ticketWatchers.ticketId, ticketId));
  return [...new Set([ticket.authorId, ...watchers.map((w) => w.userId)])].filter((userId) => userId !== actorUserId);
}

/**
 * Кто из получателей видит обращение сейчас: действующее членство в организации обращения, и для коллеги видимость
 * "организация" или роль администратора клиента. Отключённый участник и подписчик, оставшийся у личного обращения,
 * ни уведомления, ни письма не получают (итоговая проверка M4, замечание I8). Роли читаются одним запросом на всех
 * получателей (аудит 23.11.2026, находка A4).
 */
async function whoSees(ticket: TicketInfo, userIds: string[]): Promise<string[]> {
  const roles = await replyRoles(userIds, ticket.orgId);
  return userIds.filter((userId) => {
    const role = roles.get(userId);
    return role !== undefined && (userId === ticket.authorId || ticket.visibility === 'org' || role === 'client_admin');
  });
}

/**
 * Уведомление в портале каждому, кто видит обращение; письмо и сообщение в Telegram по его каналам (решения 3 и 4
 * вехи M4b): о своих обращениях хотя бы один внешний канал, об обращениях коллег по настройке.
 */
async function tell(tx: Tx, ticketId: string, ticket: TicketInfo, recipients: string[], kind: NotificationKind, mail: Mail, messageId?: string): Promise<void> {
  const locale = ticket.locale as 'ru' | 'uz' | 'en';
  const seeing = await whoSees(ticket, recipients);
  const channelsOf = await channelsForMany(tx, seeing, ticket.authorId);
  for (const userId of seeing) {
    await notifyTx(tx, { userId, kind, ticketId, orgId: ticket.orgId, payload: { number: ticket.number, title: ticket.title } });
    const own = userId === ticket.authorId;
    const channels = channelsOf.get(userId) ?? { email: true, telegram: false };
    const telegramId =
      channels.telegram && TELEGRAM_TEMPLATES.has(mail.template)
        ? await enqueueTx(tx, { channel: 'telegram', recipient: { kind: 'user', userId }, template: mail.template, payload: mail, ticketId, locale })
        : null;
    // О своём обращении письмо при выключенной почте ставится запасным к сообщению в Telegram: оно уйдёт, если
    // Telegram не доставит (бот заблокирован, сбой). Нет сообщения в Telegram: обычное письмо (решение 0036, пункт 3).
    const fallback = own && !channels.email;
    if (channels.email || fallback) {
      await enqueueTx(tx, {
        channel: 'email',
        recipient: { kind: 'user', userId },
        template: mail.template,
        payload: mail,
        ticketId,
        // Письмо об ответе связано с сообщением: недоставку видно на нём в рабочем месте (решение 21).
        ...(messageId ? { messageId } : {}),
        locale,
        ...(own ? {} : { settingsPath: CLIENT_SETTINGS_PATH }),
        ...(fallback && telegramId ? { fallbackFor: telegramId } : {}),
      });
    }
  }
}

/**
 * Сотрудникам (решение 7): уведомление в портале всегда, письмо по его настройке (упоминания, нарушения) или
 * всегда (регулярное обновление). Без письма: только уведомление.
 */
async function tellStaff(
  tx: Tx,
  ticketId: string,
  ticket: TicketInfo,
  recipients: string[],
  kind: NotificationKind,
  mail: Mail | null,
  pref: PrefKind | null,
  extra: Record<string, string> = {},
): Promise<void> {
  for (const userId of new Set(recipients)) {
    await notifyTx(tx, { userId, kind, ticketId, payload: { number: ticket.number, title: ticket.title, ...extra } });
    if (!mail || (pref && !(await emailAllowed(tx, userId, pref)))) continue;
    await enqueueTx(tx, {
      channel: 'email',
      recipient: { kind: 'user', userId },
      template: mail.template,
      payload: mail,
      ticketId,
      locale: ticket.locale as 'ru' | 'uz' | 'en',
      ...(pref ? { settingsPath: STAFF_SETTINGS_PATH } : {}),
    });
  }
}

export async function notifyTicketTx(tx: Tx, e: TicketNotice): Promise<void> {
  const ticket = (
    await tx
      .select({
        number: tickets.number,
        title: tickets.title,
        locale: tickets.locale,
        authorId: tickets.authorId,
        assigneeId: tickets.assigneeId,
        orgId: tickets.orgId,
        visibility: tickets.visibility,
      })
      .from(tickets)
      .where(eq(tickets.ticketId, e.ticketId))
      .limit(1)
  )[0];
  if (!ticket) throw new Error('уведомление: обращение не найдено');
  const ref = { number: ticket.number, title: ticket.title, url: `/tickets/SUP-${ticket.number}` };
  const staffRef = { number: ticket.number, title: ticket.title, url: `/agent/tickets/SUP-${ticket.number}` };
  switch (e.kind) {
    case 'created':
      // Подтверждение с номером получает автор, даже если обращение за него создал сотрудник (FR-NT-01).
      return tell(tx, e.ticketId, ticket, [ticket.authorId], 'ticket_created', { template: 'ticket_created', ...ref, viaEmail: e.viaEmail ?? false });
    case 'unidentified_ack':
      // Неопознанному отправителю только номер (FR-EM-05): без уведомления в портале, войти он не может.
      await enqueueTx(tx, {
        channel: 'email',
        recipient: { kind: 'user', userId: ticket.authorId },
        template: 'unidentified_ack',
        payload: { template: 'unidentified_ack', number: ticket.number, title: ticket.title },
        ticketId: e.ticketId,
        locale: ticket.locale as 'ru' | 'uz' | 'en',
      });
      return;
    case 'client_reply':
      // Ответ клиента: исполнителю уведомление в портале, без письма (решение 7).
      if (ticket.assigneeId && ticket.assigneeId !== e.actorUserId)
        await notifyTx(tx, { userId: ticket.assigneeId, kind: 'client_replied', ticketId: e.ticketId, payload: { number: ticket.number, title: ticket.title } });
      return;
    case 'staff_reply': {
      if (!e.messageId) throw new Error('уведомление: нет сообщения');
      const message = (
        await tx
          .select({ body: ticketMessages.body })
          .from(ticketMessages)
          .where(and(eq(ticketMessages.messageId, e.messageId), eq(ticketMessages.ticketId, e.ticketId), eq(ticketMessages.isInternal, false)))
          .limit(1)
      )[0];
      if (!message) return;
      return tell(tx, e.ticketId, ticket, await people(tx, e.ticketId, ticket, e.actorUserId), 'ticket_reply', { template: 'ticket_reply', ...ref, body: message.body }, e.messageId);
    }
    case 'status':
      if (!e.to || !STATUS_MAILS.has(e.to)) return;
      return tell(tx, e.ticketId, ticket, await people(tx, e.ticketId, ticket, e.actorUserId), 'ticket_status', {
        template: 'ticket_status',
        ...ref,
        status: e.to as 'waiting_customer' | 'in_development' | 'closed',
      });
    case 'resolved':
      return tell(tx, e.ticketId, ticket, await people(tx, e.ticketId, ticket, e.actorUserId), 'ticket_resolved', { template: 'ticket_resolved', ...ref });
    case 'merged':
      return tell(tx, e.ticketId, ticket, await people(tx, e.ticketId, ticket, e.actorUserId), 'ticket_status', {
        template: 'ticket_status',
        ...ref,
        status: 'closed',
        ...(e.mergedInto !== undefined ? { mergedInto: e.mergedInto } : {}),
      });
    case 'auto_closed':
      return tell(tx, e.ticketId, ticket, await people(tx, e.ticketId, ticket, null), 'ticket_status', { template: 'ticket_status', ...ref, status: 'closed', auto: true });
    case 'waiting_reminder':
      // Напоминание только автору: ответа ждут от него (FR-TK-15).
      return tell(tx, e.ticketId, ticket, [ticket.authorId], 'waiting_reminder', { template: 'waiting_reminder', ...ref, closeInDays: e.closeInDays ?? 0 });
    case 'mention':
      // Упоминание в заметке (FR-AG-16): коллеге уведомление со ссылкой и письмо по настройке.
      return tellStaff(
        tx,
        e.ticketId,
        ticket,
        (e.mentioned ?? []).filter((id) => id !== e.actorUserId),
        'mention',
        { template: 'staff_mention', ...staffRef, author: e.authorName ?? '' },
        'staff_mention',
      );
    case 'sla_breach':
      // Нарушение срока (FR-SLA-06): руководителям линии обращения.
      return tellStaff(
        tx,
        e.ticketId,
        ticket,
        e.leads ?? [],
        'sla_breach',
        { template: 'staff_breach', ...staffRef, kind: e.breach ?? 'first_response' },
        'staff_breach',
        { breach: e.breach ?? 'first_response' },
      );
    case 'snooze_returned':
      // Отложенное вернулось (решение 13 вехи M3): исполнителю уведомление в портале.
      return ticket.assigneeId ? tellStaff(tx, e.ticketId, ticket, [ticket.assigneeId], 'snooze_returned', null, null) : undefined;
    case 'update_due':
      // Регулярное обновление "В разработке" (FR-SLA-09): исполнителю за рабочий день до срока, в портале и письмом.
      return ticket.assigneeId
        ? tellStaff(tx, e.ticketId, ticket, [ticket.assigneeId], 'update_due', { template: 'staff_update_due', ...staffRef }, null)
        : undefined;
  }
}

/**
 * Сообщение дежурным о P1 (FR-SLA-07, решение 8): одно на обращение, пока нет первого ответа. Письмо списку дежурных
 * и сообщение в служебный чат ставятся строками очереди; адреса, бот и чат берутся из настроек при отправке.
 * alreadyMarked: отметку oncall_notified_on уже поставила вставка обращения (клиент колонку не обновляет).
 */
export async function oncallP1Tx(tx: Tx, ticketId: string, opts: { alreadyMarked?: boolean } = {}): Promise<void> {
  const t = (
    await tx
      .select({
        number: tickets.number,
        title: tickets.title,
        orgId: tickets.orgId,
        priority: tickets.priority,
        firstRespondedOn: tickets.firstRespondedOn,
        oncallNotifiedOn: tickets.oncallNotifiedOn,
      })
      .from(tickets)
      .where(eq(tickets.ticketId, ticketId))
      .limit(1)
  )[0];
  if (!t || t.priority !== 'p1' || t.firstRespondedOn) return;
  if (!opts.alreadyMarked) {
    if (t.oncallNotifiedOn) return;
    await tx.update(tickets).set({ oncallNotifiedOn: sql`now()` }).where(eq(tickets.ticketId, ticketId));
  }
  const payload = { template: 'oncall_p1' as const, number: t.number, title: t.title, url: `/agent/tickets/SUP-${t.number}`, orgName: (await organizationName(t.orgId)) ?? '' };
  for (const channel of ['email', 'telegram'] as const)
    await enqueueTx(tx, { channel, recipient: { kind: 'oncall' }, template: 'oncall_p1', payload, ticketId, locale: 'ru' });
}
