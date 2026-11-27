import 'server-only';
import { and, eq, sql } from 'drizzle-orm';
import type { Tx } from '@/db/client';
import { channelsForMany, emailAllowed, type NotificationKind, notifyTx, type PrefKind } from '@/modules/hdn/api/notifications';
import { replyConfig } from '@/modules/hdn/api/inbound';
import { enqueueTx, TELEGRAM_TEMPLATES } from '@/modules/hdn/api/outbox';
import { organizationName, replyRoles } from '@/modules/hdu/api/recipients';
import { aiCallbackData, aiLinkToken } from '../ai-link';
import { csatToken } from '../csat-link';
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
    | 'update_due'
    | 'dev_task_closed'
    | 'csat_low'
    | 'ai_answer'
    | 'ai_ack'
    | 'problem_update';
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
  /** Закрытая задача разработки: её номер в таск-менеджере. Получатели в leads: исполнитель или руководители линии. */
  devTaskRef?: string;
  /** Низкая оценка: сама оценка. Получатели в leads. */
  score?: number;
  /** Ответ Теза решением (план M5b, задача 6): вступление и решение из hdk_published, без слов модели. */
  aiAnswer?: { introId: string; solutionTitle: string; lines: string[]; articleNumber: number };
  /** Рассылка по известной проблеме (веха M5c, FR-NT-12): номер и статус проблемы, итог закрытия. */
  problemUpdate?: { problemRef: string; problemStatus: string; closing: boolean };
  /** Подтверждение без Теза: срок ответа сотрудника. */
  aiAck?: { dueOn: string | null; startOn: string | null; timeZone: string };
};

/** Смены статуса, о которых клиенту уходит письмо (решение 6). "Решено" идёт отдельным письмом. */
const STATUS_MAILS = new Set<TicketStatus>(['waiting_customer', 'in_development', 'closed']);
const CLIENT_SETTINGS_PATH = '/settings';
const STAFF_SETTINGS_PATH = '/agent/account';

type TicketInfo = { number: number; title: string; locale: string; authorId: string; assigneeId: string | null; orgId: string; visibility: Visibility; csatScore: number | null };
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
/**
 * Письмо автору о закрытии обращения несёт ссылку оценки (FR-TK-11, UX-C-07). Объединённому дублю оценка не нужна.
 * Коллегам ссылка не уходит: оценку ставит только автор.
 */
function withRating(mail: Mail, ticket: TicketInfo): Mail {
  if (mail.template !== 'ticket_status' || mail.status !== 'closed' || mail.mergedInto !== undefined) return mail;
  // Обращение уже оценено (закрыто, оценено, открыто снова и закрыто): вторая оценка не ставится, ссылки не нужны.
  if (ticket.csatScore !== null) return mail;
  // Ключ подписи общий с адресами ответа. Не задан: письмо уходит без ссылок, оценка остаётся на странице обращения.
  const cfg = replyConfig();
  return cfg ? { ...mail, rateUrl: `/rate?t=${csatToken(ticket.number, ticket.authorId, cfg.secret)}` } : mail;
}

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
        payload: own ? withRating(mail, ticket) : mail,
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
    await notifyTx(tx, { userId, kind, ticketId, orgId: ticket.orgId, payload: { number: ticket.number, title: ticket.title, ...extra } });
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
        csatScore: tickets.csatScore,
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
        await notifyTx(tx, { userId: ticket.assigneeId, kind: 'client_replied', ticketId: e.ticketId, orgId: ticket.orgId, payload: { number: ticket.number, title: ticket.title } });
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
    case 'problem_update': {
      // Текст только из сообщения рассылки этого обращения (T23): его выбирает модуль обращений по идентификатору.
      if (!e.messageId || !e.problemUpdate) throw new Error('уведомление: нет сообщения рассылки');
      const message = (
        await tx
          .select({ body: ticketMessages.body })
          .from(ticketMessages)
          .where(and(eq(ticketMessages.messageId, e.messageId), eq(ticketMessages.ticketId, e.ticketId), eq(ticketMessages.isInternal, false)))
          .limit(1)
      )[0];
      if (!message) return;
      return tell(tx, e.ticketId, ticket, await people(tx, e.ticketId, ticket, e.actorUserId), 'problem_update', { template: 'problem_update', ...ref, body: message.body, ...e.problemUpdate }, e.messageId);
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
    case 'ai_answer': {
      // Ответ Теза (FR-NT-11, FR-EM-12): только автору, ссылки и кнопки подписаны его идентификатором и сообщением.
      // Ключ подписи общий с адресами ответа; не задан: письмо без ссылок, кнопки в портале.
      if (!e.aiAnswer || !e.messageId) return;
      const cfg = replyConfig();
      const now = new Date();
      const signed = cfg
        ? {
            helpedUrl: `/ai-answer?t=${aiLinkToken({ messageId: e.messageId, userId: ticket.authorId, choice: 'helped', now }, cfg.secret)}`,
            staffUrl: `/ai-answer?t=${aiLinkToken({ messageId: e.messageId, userId: ticket.authorId, choice: 'need_staff', now }, cfg.secret)}`,
            helpedData: aiCallbackData({ messageId: e.messageId, userId: ticket.authorId, choice: 'helped' }, cfg.secret),
            staffData: aiCallbackData({ messageId: e.messageId, userId: ticket.authorId, choice: 'need_staff' }, cfg.secret),
          }
        : {};
      return tell(tx, e.ticketId, ticket, [ticket.authorId], 'ticket_reply', {
        template: 'tez_answer',
        ...ref,
        introId: e.aiAnswer.introId,
        solutionTitle: e.aiAnswer.solutionTitle,
        lines: e.aiAnswer.lines.slice(0, 30),
        solutionUrl: `/help/a/${e.aiAnswer.articleNumber}`,
        ...signed,
      }, e.messageId);
    }
    case 'ai_ack':
      // Подтверждение без Теза при передаче ai_disabled и ai_limit (FR-AI-15): автору, со сроком ответа сотрудника.
      if (!e.aiAck) return;
      return tell(tx, e.ticketId, ticket, [ticket.authorId], 'ticket_status', { template: 'tez_ack', ...ref, ...e.aiAck });
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
    case 'dev_task_closed':
      // Задача разработки закрыта (FR-DEV-05): напоминание проверить и сообщить клиенту, в портале и письмом. Получает
      // его и тот, кто сам закрыл задачу: это напоминание о следующем шаге, а не известие о чужом действии.
      return tellStaff(tx, e.ticketId, ticket, e.leads ?? [], 'dev_task_closed', { template: 'staff_dev_task_closed', ...staffRef, ref: e.devTaskRef ?? '' }, null, {
        ref: e.devTaskRef ?? '',
      });
    case 'csat_low':
      // Оценка 1 или 2 (FR-AUTO-12): сотрудникам Customer Care уведомление в портале и письмо. В письме оценка, номер,
      // тема и организация; комментария и причины клиента нет, их читают на странице обращения.
      return tellStaff(
        tx,
        e.ticketId,
        ticket,
        e.leads ?? [],
        'csat_low',
        { template: 'staff_csat_low', ...staffRef, score: e.score ?? 0, orgName: (await organizationName(ticket.orgId)) ?? '' },
        null,
        { score: String(e.score ?? 0) },
      );
  }
}

/**
 * Сообщение дежурным о P1 (FR-SLA-07, решение 8): одно на обращение, пока нет первого ответа. Письмо списку дежурных
 * и сообщение в служебный чат ставятся строками очереди; адреса, бот и чат берутся из настроек при отправке.
 * Вызывает его действие предустановленного правила "P1: сообщение дежурным" из транзакции системы (план M8,
 * задача 10): отметку oncall_notified_on ставит оно же. Возвращает, ушло ли сообщение: ложь значит, что обращение
 * не P1, первый ответ уже дан или сообщение по этому обращению уже уходило.
 */
export async function oncallP1Tx(tx: Tx, ticketId: string): Promise<boolean> {
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
  if (!t || t.priority !== 'p1' || t.firstRespondedOn || t.oncallNotifiedOn) return false;
  await tx.update(tickets).set({ oncallNotifiedOn: sql`now()` }).where(eq(tickets.ticketId, ticketId));
  const payload = { template: 'oncall_p1' as const, number: t.number, title: t.title, url: `/agent/tickets/SUP-${t.number}`, orgName: (await organizationName(t.orgId)) ?? '' };
  for (const channel of ['email', 'telegram'] as const)
    await enqueueTx(tx, { channel, recipient: { kind: 'oncall' }, template: 'oncall_p1', payload, ticketId, locale: 'ru' });
  return true;
}
