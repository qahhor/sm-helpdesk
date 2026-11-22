import 'server-only';
import { and, asc, eq, inArray, isNotNull, isNull, lt, lte, notInArray, or, sql } from 'drizzle-orm';
import type { Tx } from '@/db/client';
import { type SystemActor, withActor } from '@/db/with-actor';
import { readSetting, writeAudit } from '@/modules/hdc/api';
import { notifyTx } from '@/modules/hdn/api/notifications';
import { enqueueTx } from '@/modules/hdn/api/outbox';
import { adminIds, lineLeads } from '@/modules/hdu/api/recipients';
import { readSlaConfig } from '@/modules/hdr/api';
import {
  AUTOCLOSE_RESOLVED_SETTING,
  AUTOCLOSE_WAITING_SETTING,
  DAY_SETTING_MAX,
  DAY_SETTING_MIN,
  DAY_SETTINGS_DEFAULT,
  SWEEP_BATCH,
  type TicketStatus,
  UPDATE_DUE_SETTING,
  WAITING_REMINDER_SETTING,
} from '../pref';
import { ticketEvents, ticketMessages, ticketPresence, tickets } from '../schema';
import { addWorkingDays } from '../sla';
import { systemText, type SystemTextKey } from '../system-text';
import { notifyTicketTx } from './notify';
import { needsSlaRefreshTx, refreshSla } from './sla';

// Модуль hdt, слой core: задача раз в минуту (решения 2, 8, 13, 14 плана M3; FR-TK-10, FR-TK-15, 10.5). Каждый шаг
// своей транзакцией системного актора, пачками по 200 строк с FOR UPDATE SKIP LOCKED: два экземпляра задачи не берут
// одни строки. Условия от момента now, отметки однократные: повторный запуск ничего не дублирует, отставший процесс
// догоняет всё сразу.

export type MinuteResult = {
  breached: number;
  unsnoozed: number;
  closed: number;
  refreshed: number;
  presenceRemoved: number;
  reminded: number;
  updateDue: number;
  /** Гостей, чьи обращения перешли пользователю (шаг слоя api, решение 13 вехи M4). */
  guestsMerged?: number;
};

const SETTLED: TicketStatus[] = ['resolved', 'closed'];
const DAY_MS = 86_400_000;

type DaySetting = keyof typeof DAY_SETTINGS_DEFAULT;

/** Срок в рабочих днях из настроек администратора (решение 24 вехи M4). Нет значения или оно неверно: значение ТЗ. */
async function daySetting(code: DaySetting): Promise<number> {
  const value = await readSetting(code);
  return typeof value === 'number' && Number.isInteger(value) && value >= DAY_SETTING_MIN && value <= DAY_SETTING_MAX ? value : DAY_SETTINGS_DEFAULT[code];
}

/** Досчёт сроков, где пересчёт после действия клиента не прошёл (решение 2). */
async function refreshStale(actor: SystemActor, now: Date): Promise<number> {
  return withActor(actor, async (tx) => {
    const ids = await needsSlaRefreshTx(tx, SWEEP_BATCH);
    for (const id of ids) await refreshSla(tx, id, now);
    return ids.length;
  });
}

/** Нарушение срока отмечается один раз колонкой и внутренним событием "срок нарушен" (решение 8). */
async function markBreaches(actor: SystemActor, now: Date): Promise<number> {
  const leads = { l1: await lineLeads('l1'), l2: await lineLeads('l2') };
  return withActor(actor, async (tx) => {
    const first = await tx
      .select({ ticketId: tickets.ticketId, orgId: tickets.orgId, queue: tickets.queue })
      .from(tickets)
      .where(
        and(
          isNull(tickets.firstRespondedOn),
          isNull(tickets.firstResponseBreachedOn),
          lt(tickets.firstResponseDueOn, now),
          notInArray(tickets.status, SETTLED),
        ),
      )
      .orderBy(asc(tickets.firstResponseDueOn))
      .limit(SWEEP_BATCH)
      .for('update', { skipLocked: true });
    // На паузе срок решения не нарушается: при выходе из паузы он сдвинется.
    const resolution = await tx
      .select({ ticketId: tickets.ticketId, orgId: tickets.orgId, queue: tickets.queue })
      .from(tickets)
      .where(and(isNull(tickets.resolutionBreachedOn), lt(tickets.resolutionDueOn, now), isNull(tickets.slaPausedOn), notInArray(tickets.status, SETTLED)))
      .orderBy(asc(tickets.resolutionDueOn))
      .limit(SWEEP_BATCH)
      .for('update', { skipLocked: true });
    if (first.length > 0)
      await tx.update(tickets).set({ firstResponseBreachedOn: now }).where(inArray(tickets.ticketId, first.map((t) => t.ticketId)));
    if (resolution.length > 0)
      await tx.update(tickets).set({ resolutionBreachedOn: now }).where(inArray(tickets.ticketId, resolution.map((t) => t.ticketId)));
    const events = [
      ...first.map((t) => ({ ...t, kind: 'first_response' })),
      ...resolution.map((t) => ({ ...t, kind: 'resolution' })),
    ].map((t) => ({ orgId: t.orgId, ticketId: t.ticketId, kind: 'due' as const, actorType: 'system' as const, payload: { kind: t.kind }, isInternal: true }));
    if (events.length > 0) await tx.insert(ticketEvents).values(events);
    // Руководителям линии обращения (FR-SLA-06, решение 7 вехи M4): одно уведомление на нарушение.
    for (const [list, breach] of [
      [first, 'first_response'],
      [resolution, 'resolution'],
    ] as const)
      for (const t of list)
        await notifyTicketTx(tx, { ticketId: t.ticketId, kind: 'sla_breach', actorUserId: null, breach, leads: t.queue === 'l1' ? leads.l1 : leads.l2 });
    return events.length;
  });
}

/** Отложенное с прошедшим временем возвращается в очередь с событием (решение 13). */
async function returnSnoozed(actor: SystemActor, now: Date): Promise<number> {
  return withActor(actor, async (tx) => {
    const due = await tx
      .select({ ticketId: tickets.ticketId, orgId: tickets.orgId })
      .from(tickets)
      .where(and(isNotNull(tickets.snoozedUntil), lte(tickets.snoozedUntil, now)))
      .limit(SWEEP_BATCH)
      .for('update', { skipLocked: true });
    if (due.length === 0) return 0;
    await tx.update(tickets).set({ snoozedUntil: null }).where(inArray(tickets.ticketId, due.map((t) => t.ticketId)));
    await tx.insert(ticketEvents).values(
      due.map((t) => ({ orgId: t.orgId, ticketId: t.ticketId, kind: 'snooze' as const, actorType: 'system' as const, payload: { until: null, returned: true }, isInternal: true })),
    );
    for (const t of due) await notifyTicketTx(tx, { ticketId: t.ticketId, kind: 'snooze_returned', actorUserId: null });
    return due.length;
  });
}

/** Закрыть системой: статус, событие, сообщение клиенту на языке обращения, журнал, сроки. */
async function closeBySystem(
  tx: Tx,
  t: { ticketId: string; orgId: string; locale: string },
  from: 'resolved' | 'waiting_customer',
  text: SystemTextKey,
  days: number,
  now: Date,
) {
  await tx.update(tickets).set({ status: 'closed', closedOn: sql`now()` }).where(eq(tickets.ticketId, t.ticketId));
  await tx.insert(ticketEvents).values({ orgId: t.orgId, ticketId: t.ticketId, kind: 'status', actorType: 'system', payload: { from, to: 'closed' } });
  await tx.insert(ticketMessages).values({ orgId: t.orgId, ticketId: t.ticketId, authorType: 'system', body: systemText(t.locale, text, { days }) });
  await writeAudit(tx, { action: 'ticket.status_changed', objectType: 'ticket', objectId: t.ticketId, orgId: t.orgId, diff: { from, to: 'closed', auto: true } });
  await refreshSla(tx, t.ticketId, now);
  await notifyTicketTx(tx, { ticketId: t.ticketId, kind: 'auto_closed', actorUserId: null });
}

/**
 * Автозакрытие: "Решено" без реакции 5 рабочих дней (FR-TK-10), "Ждём вашего ответа" 7 рабочих дней (FR-TK-15), сроки из
 * настроек администратора (решение 24 вехи M4),
 * только если после начала отсчёта клиент не писал. Отбор по календарным дням (рабочих не меньше), затем по
 * рабочему календарю поддержки.
 */
async function autoClose(actor: SystemActor, now: Date): Promise<number> {
  const resolvedDays = await daySetting(AUTOCLOSE_RESOLVED_SETTING);
  const waitingDays = await daySetting(AUTOCLOSE_WAITING_SETTING);
  return withActor(actor, async (tx) => {
    const calendar = (await readSlaConfig(tx)).calendar;
    const resolved = await tx
      .select({ ticketId: tickets.ticketId, orgId: tickets.orgId, locale: tickets.locale, since: tickets.resolvedOn })
      .from(tickets)
      .where(and(eq(tickets.status, 'resolved'), lte(tickets.resolvedOn, new Date(now.getTime() - resolvedDays * DAY_MS))))
      .orderBy(asc(tickets.resolvedOn))
      .limit(SWEEP_BATCH)
      .for('update', { skipLocked: true });
    const waiting = await tx
      .select({ ticketId: tickets.ticketId, orgId: tickets.orgId, locale: tickets.locale, since: tickets.slaPausedOn })
      .from(tickets)
      .where(
        and(
          eq(tickets.status, 'waiting_customer'),
          lte(tickets.slaPausedOn, new Date(now.getTime() - waitingDays * DAY_MS)),
          or(isNull(tickets.lastClientMessageOn), lte(tickets.lastClientMessageOn, tickets.slaPausedOn)),
        ),
      )
      .orderBy(asc(tickets.slaPausedOn))
      .limit(SWEEP_BATCH)
      .for('update', { skipLocked: true });
    let closed = 0;
    for (const t of resolved)
      if (t.since && addWorkingDays(t.since, resolvedDays, calendar).getTime() <= now.getTime()) {
        await closeBySystem(tx, t, 'resolved', 'autoCloseResolved', resolvedDays, now);
        closed++;
      }
    for (const t of waiting)
      if (t.since && addWorkingDays(t.since, waitingDays, calendar).getTime() <= now.getTime()) {
        await closeBySystem(tx, t, 'waiting_customer', 'autoCloseWaiting', waitingDays, now);
        closed++;
      }
    return closed;
  });
}

/**
 * Напоминание клиенту (FR-TK-15): "Ждём вашего ответа" N рабочих дней без сообщения клиента. Одно напоминание
 * за период ожидания: отметка waiting_reminded_on позже начала паузы. Если пора уже закрывать, напоминания нет.
 */
async function remindWaiting(actor: SystemActor, now: Date): Promise<number> {
  const reminderDays = await daySetting(WAITING_REMINDER_SETTING);
  const waitingDays = await daySetting(AUTOCLOSE_WAITING_SETTING);
  if (reminderDays >= waitingDays) return 0;
  return withActor(actor, async (tx) => {
    const calendar = (await readSlaConfig(tx)).calendar;
    const due = await tx
      .select({ ticketId: tickets.ticketId, since: tickets.slaPausedOn })
      .from(tickets)
      .where(
        and(
          eq(tickets.status, 'waiting_customer'),
          lte(tickets.slaPausedOn, new Date(now.getTime() - reminderDays * DAY_MS)),
          or(isNull(tickets.waitingRemindedOn), lt(tickets.waitingRemindedOn, tickets.slaPausedOn)),
          or(isNull(tickets.lastClientMessageOn), lte(tickets.lastClientMessageOn, tickets.slaPausedOn)),
        ),
      )
      .orderBy(asc(tickets.slaPausedOn))
      .limit(SWEEP_BATCH)
      .for('update', { skipLocked: true });
    let reminded = 0;
    for (const t of due) {
      if (!t.since || addWorkingDays(t.since, reminderDays, calendar).getTime() > now.getTime()) continue;
      if (addWorkingDays(t.since, waitingDays, calendar).getTime() <= now.getTime()) continue;
      await tx.update(tickets).set({ waitingRemindedOn: now }).where(eq(tickets.ticketId, t.ticketId));
      await notifyTicketTx(tx, { ticketId: t.ticketId, kind: 'waiting_reminder', actorUserId: null, closeInDays: waitingDays - reminderDays });
      reminded++;
    }
    return reminded;
  });
}

/**
 * Регулярное обновление (FR-SLA-09): клиент получает сообщение сотрудника по обращению "В разработке" не реже
 * раза в N рабочих дней (настройка, по умолчанию 5). За рабочий день до срока исполнитель получает напоминание,
 * одно за период. Начало периода: последний публичный ответ сотрудника или переход в "В разработке".
 */
async function remindUpdates(actor: SystemActor, now: Date): Promise<number> {
  const days = await daySetting(UPDATE_DUE_SETTING);
  return withActor(actor, async (tx) => {
    const calendar = (await readSlaConfig(tx)).calendar;
    // Отбор в базе: только обращения, у которых напоминания за этот период ещё не было и которые по календарным дням
    // уже могут быть близки к сроку (рабочих дней не меньше календарных). Иначе первые 200 строк проверялись бы
    // каждую минуту, а остальные не доходили бы до проверки (итоговая проверка M4, замечание I9).
    const earliest = new Date(now.getTime() - Math.max(days - 1, 0) * DAY_MS);
    const result = await tx.execute<{ ticket_id: string; since: Date | string; reminded: Date | string | null }>(sql`
      select c.ticket_id, c.reminded, c.since
        from (select t.ticket_id, t.update_reminded_on as reminded, greatest(
                coalesce((select max(m.created_on) from hdt_ticket_messages m
                           where m.ticket_id = t.ticket_id and m.author_type = 'staff' and not m.is_internal), t.created_on),
                coalesce((select max(e.created_on) from hdt_ticket_events e
                           where e.ticket_id = t.ticket_id and e.kind = 'status' and e.payload ->> 'to' = 'in_development'), t.created_on)
              ) as since
                from hdt_tickets t
               where t.status = 'in_development' and t.assignee_id is not null) c
       where c.since <= ${earliest.toISOString()}::timestamptz
         and (c.reminded is null or c.reminded < c.since)
       order by c.since
       limit ${SWEEP_BATCH}`);
    let reminded = 0;
    for (const row of result.rows) {
      const since = new Date(row.since);
      if (row.reminded && new Date(row.reminded).getTime() >= since.getTime()) continue;
      // Строка блокируется перед отметкой: два параллельных запуска не напомнят дважды.
      const locked = await tx.execute(sql`select 1 from hdt_tickets where ticket_id = ${row.ticket_id} and status = 'in_development' and (update_reminded_on is null or update_reminded_on < ${since.toISOString()}::timestamptz) for update skip locked`);
      if (locked.rows.length === 0) continue;
      if (addWorkingDays(since, Math.max(days - 1, 0), calendar).getTime() > now.getTime()) continue;
      await tx.update(tickets).set({ updateRemindedOn: now }).where(eq(tickets.ticketId, row.ticket_id));
      await notifyTicketTx(tx, { ticketId: row.ticket_id, kind: 'update_due', actorUserId: null });
      reminded++;
    }
    return reminded;
  });
}

/**
 * Праздники следующего года (FR-SLA-12): с 1 декабря по Ташкенту, если список следующего года пуст, администраторам
 * уведомление и письмо. Одно напоминание на год: уже отправленное видно по уведомлению с этим годом.
 */
export async function holidaysReminderTx(actor: SystemActor, now: Date): Promise<number> {
  const local = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tashkent', year: 'numeric', month: '2-digit' }).formatToParts(now);
  const year = Number(local.find((p) => p.type === 'year')?.value);
  const month = Number(local.find((p) => p.type === 'month')?.value);
  if (month !== 12) return 0;
  const next = year + 1;
  const admins = await adminIds();
  if (admins.length === 0) return 0;
  return withActor(actor, async (tx) => {
    const calendar = (await readSlaConfig(tx)).calendar;
    if (calendar.holidays.some((day) => day.startsWith(`${next}-`))) return 0;
    const sent = await tx.execute(sql`select 1 from hdn_notifications where kind = 'holidays_reminder' and payload ->> 'year' = ${String(next)} limit 1`);
    if (sent.rows.length > 0) return 0;
    for (const userId of admins) {
      await notifyTx(tx, { userId, kind: 'holidays_reminder', payload: { year: next } });
      await enqueueTx(tx, {
        channel: 'email',
        recipient: { kind: 'user', userId },
        template: 'holidays_reminder',
        payload: { template: 'holidays_reminder', year: next, url: '/agent/settings/sla' },
        locale: 'ru',
      });
    }
    return admins.length;
  });
}

/** Отметки присутствия с истёкшим сроком (10.5: строки старше минуты удаляет фоновая задача). */
async function removePresence(actor: SystemActor, now: Date): Promise<number> {
  return withActor(actor, async (tx) => {
    const removed = await tx.delete(ticketPresence).where(lt(ticketPresence.expiresOn, now)).returning({ ticketId: ticketPresence.ticketId });
    return removed.length;
  });
}

/**
 * Шаг своей транзакцией: сбой одного шага (испорченный календарь, взаимная блокировка) пишется в журнал процесса
 * и не останавливает остальные. Следующая минута повторит его (итоговая проверка M3).
 */
async function step(name: string, run: () => Promise<number>): Promise<number> {
  try {
    return await run();
  } catch (error) {
    console.error(`tickets.minute: шаг ${name} не выполнен: ${error instanceof Error ? error.message : String(error)}`);
    return 0;
  }
}

export async function ticketsMinuteTx(actor: SystemActor, now: Date): Promise<MinuteResult> {
  const refreshed = await step('refresh', () => refreshStale(actor, now));
  const breached = await step('breaches', () => markBreaches(actor, now));
  const unsnoozed = await step('snoozed', () => returnSnoozed(actor, now));
  const reminded = await step('reminder', () => remindWaiting(actor, now));
  const updateDue = await step('update-due', () => remindUpdates(actor, now));
  await step('holidays', () => holidaysReminderTx(actor, now));
  const closed = await step('auto-close', () => autoClose(actor, now));
  const presenceRemoved = await step('presence', () => removePresence(actor, now));
  return { breached, unsnoozed, closed, refreshed, presenceRemoved, reminded, updateDue };
}
