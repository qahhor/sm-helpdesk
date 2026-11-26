import 'server-only';
import { and, asc, eq, isNotNull, ne, sql } from 'drizzle-orm';
import type { Tx } from '@/db/client';
import type { StaffActor } from '@/db/with-actor';
import { writeAudit } from '@/modules/hdc/api';
import { devTaskClosedTx, ticketNumbersTx } from '@/modules/hdt/api/dev-tasks';
import { HdwError } from '../error';
import { DEV_TASK_CLOSED, type DevTaskStatus, type DevTrackerKind } from '../pref';
import { devTaskLinks, devTasks } from '../schema';
import { ideaDevTaskClosedTx } from './idea-hook';

// Модуль hdw, слой core: задачи разработки и привязки обращений и идей (ТЗ 7.9, FR-DEV-02, 05, 06, FR-IDEA-12; план M8,
// задача 7; план M7, задача 9).
// Работает в транзакции вызывающего: сотрудника (передача, отвязка, ручная смена статуса) или системы (вебхук и
// опрос таск-менеджера). Обращение меняет модуль hdt своими функциями, здесь только таблицы hdw_dev_*.

export type DevTask = {
  devTaskId: string;
  tracker: DevTrackerKind;
  /** Номер задачи в таск-менеджере. */
  externalId: string;
  url: string;
  /** Пусто: задача найдена по номеру через API, названия API не отдаёт. */
  title: string;
  status: DevTaskStatus;
  version: string | null;
  syncedOn: Date | null;
  /** Когда ушло напоминание о закрытии. Пусто: не уходило или задачу открыли снова. */
  closedNotifiedOn: Date | null;
};

const columns = {
  devTaskId: devTasks.devTaskId,
  tracker: devTasks.tracker,
  externalId: devTasks.externalId,
  url: devTasks.url,
  title: devTasks.title,
  status: devTasks.status,
  version: devTasks.version,
  syncedOn: devTasks.syncedOn,
  closedNotifiedOn: devTasks.closedNotifiedOn,
};

const isClosed = (status: DevTaskStatus): boolean => DEV_TASK_CLOSED.includes(status);

/** Задача по номеру без учёта регистра (индекс hdw_dev_tasks_u1). */
export async function devTaskByRefTx(tx: Tx, tracker: DevTrackerKind, ref: string): Promise<DevTask | null> {
  const [row] = await tx
    .select(columns)
    .from(devTasks)
    .where(and(eq(devTasks.tracker, tracker), sql`lower(${devTasks.externalId}) = ${ref.toLowerCase()}`))
    .limit(1);
  return row ?? null;
}

/** Задача по идентификатору с блокировкой строки: смена статуса идёт по одной. */
export async function lockDevTaskTx(tx: Tx, devTaskId: string): Promise<DevTask | null> {
  const [row] = await tx.select(columns).from(devTasks).where(eq(devTasks.devTaskId, devTaskId)).limit(1).for('update');
  return row ?? null;
}

export type LinkInput = { tracker: DevTrackerKind; externalId: string; url: string; title: string; status?: DevTaskStatus; version?: string | null };

/**
 * Задача с этим номером; задачи нет: она создаётся (FR-DEV-06). У существующей задачи адрес и название не меняются.
 * Создание задачи с одним номером идёт по одному под блокировкой транзакции. Закрытая задача: task_closed (напоминание
 * по ней уже ушло, новая привязка осталась бы без него).
 */
async function openTaskForLinkTx(tx: Tx, input: LinkInput): Promise<{ task: DevTask; created: boolean }> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`hdw.dev_task:${input.tracker}:${input.externalId.toLowerCase()}`}))`);
  let task = await devTaskByRefTx(tx, input.tracker, input.externalId);
  const created = task === null;
  if (!task) {
    const [row] = await tx
      .insert(devTasks)
      .values({
        tracker: input.tracker,
        externalId: input.externalId,
        url: input.url,
        title: input.title,
        status: input.status ?? 'todo',
        version: input.version ?? null,
        // Задача из API сверена с таск-менеджером только что: опрос вернётся к ней через 15 минут.
        ...(input.tracker === 'smartup' ? { syncedOn: sql`now()` } : {}),
      })
      .returning(columns);
    if (!row) throw new Error('hdw: задача разработки не сохранена');
    task = row;
  }
  if (isClosed(task.status)) throw new HdwError('task_closed');
  return { task, created };
}

/**
 * Привязать обращение к задаче с этим номером; задачи нет: она создаётся (FR-DEV-06). Отказы: already_linked (у
 * обращения уже есть задача), task_closed. Строку обращения вызывающий уже заблокировал.
 */
export async function linkTicketTx(tx: Tx, ticket: { ticketId: string; orgId: string }, input: LinkInput): Promise<{ task: DevTask; created: boolean }> {
  const [linked] = await tx.select({ linkId: devTaskLinks.linkId }).from(devTaskLinks).where(eq(devTaskLinks.ticketId, ticket.ticketId)).limit(1);
  if (linked) throw new HdwError('already_linked');
  const { task, created } = await openTaskForLinkTx(tx, input);
  await tx.insert(devTaskLinks).values({ orgId: ticket.orgId, devTaskId: task.devTaskId, ticketId: ticket.ticketId });
  return { task, created };
}

/**
 * Привязать идею к задаче (ТЗ FR-IDEA-12, FR-DEV-06; план M7, решение 18). Строка без организации: идея общая для
 * клиентов всех организаций. У идеи одна задача: already_linked. Строку идеи вызывающий (модуль hdi) уже заблокировал,
 * привязку ставит только product или admin (политика hdw_dev_task_links_moderator_insert, миграция 0082).
 */
export async function linkIdeaTx(tx: Tx, ideaId: string, input: LinkInput): Promise<{ task: DevTask; created: boolean }> {
  const [linked] = await tx.select({ linkId: devTaskLinks.linkId }).from(devTaskLinks).where(eq(devTaskLinks.ideaId, ideaId)).limit(1);
  if (linked) throw new HdwError('already_linked');
  const { task, created } = await openTaskForLinkTx(tx, input);
  await tx.insert(devTaskLinks).values({ orgId: null, devTaskId: task.devTaskId, ideaId });
  return { task, created };
}

/** Задача разработки идеи. Привязки нет: null. */
export async function devTaskOfIdeaTx(tx: Tx, ideaId: string): Promise<DevTask | null> {
  const [row] = await tx.select(columns).from(devTaskLinks).innerJoin(devTasks, eq(devTasks.devTaskId, devTaskLinks.devTaskId)).where(eq(devTaskLinks.ideaId, ideaId)).limit(1);
  return row ?? null;
}

/** Снять привязку обращения. Возвращает задачу, к которой оно было привязано; привязки нет: null. */
export async function unlinkTicketTx(tx: Tx, ticketId: string): Promise<DevTask | null> {
  const [removed] = await tx.delete(devTaskLinks).where(eq(devTaskLinks.ticketId, ticketId)).returning({ devTaskId: devTaskLinks.devTaskId });
  if (!removed) return null;
  const [task] = await tx.select(columns).from(devTasks).where(eq(devTasks.devTaskId, removed.devTaskId)).limit(1);
  return task ?? null;
}

/** Задача обращения и номера других обращений, привязанных к ней же. Привязки нет: null. */
export async function devTaskOfTicketTx(tx: Tx, ticketId: string): Promise<{ task: DevTask; otherTickets: number[] } | null> {
  const [row] = await tx
    .select(columns)
    .from(devTaskLinks)
    .innerJoin(devTasks, eq(devTasks.devTaskId, devTaskLinks.devTaskId))
    .where(eq(devTaskLinks.ticketId, ticketId))
    .limit(1);
  if (!row) return null;
  const others = await tx
    .select({ ticketId: devTaskLinks.ticketId })
    .from(devTaskLinks)
    .where(and(eq(devTaskLinks.devTaskId, row.devTaskId), ne(devTaskLinks.ticketId, ticketId), isNotNull(devTaskLinks.ticketId)))
    .orderBy(asc(devTaskLinks.linkId))
    .limit(OTHER_TICKETS_MAX);
  const numbers = await ticketNumbersTx(tx, others.flatMap((item) => (item.ticketId ? [item.ticketId] : [])));
  return { task: row, otherTickets: [...numbers.values()].sort((a, b) => a - b) };
}

/** Больше стольких "также привязаны" блок на странице обращения не показывает. */
const OTHER_TICKETS_MAX = 50;

/** synced: момент сверки с таск-менеджером (вебхук, опрос). У ручной смены статуса его нет. */
export type StatusChange = { status: DevTaskStatus; version?: string | null; url?: string; synced?: Date };

/**
 * Записать статус задачи, пришедший от сотрудника (ручной режим) или из таск-менеджера (вебхук, опрос). Строку задачи
 * вызывающий заблокировал. Изменение пишется в журнал аудита. Когда задача стала закрытой (done, cancelled), один раз
 * на закрытие (closed_notified_on) каждому привязанному обращению "В разработке" уходит напоминание исполнителю;
 * статус обращений не меняется (FR-DEV-05). Задачу открыли снова: отметка снимается, следующее закрытие напомнит
 * опять. Повтор того же статуса ничего не меняет и не напоминает. Возвращает число напоминаний.
 */
export async function applyDevTaskStatusTx(tx: Tx, task: DevTask, change: StatusChange, actor: StaffActor | null): Promise<{ changed: boolean; reminded: number }> {
  const version = change.version === undefined ? task.version : change.version;
  const url = change.url ?? task.url;
  const changed = task.status !== change.status || task.version !== version || task.url !== url;
  const closed = isClosed(change.status);
  const updated = await tx
    .update(devTasks)
    .set({
      status: change.status,
      version,
      url,
      ...(change.synced ? { syncedOn: change.synced } : {}),
      // Напоминание одно на закрытие: строка заблокирована, отметка ставится вместе со статусом.
      closedNotifiedOn: closed ? sql`coalesce(${devTasks.closedNotifiedOn}, now())` : null,
    })
    .where(eq(devTasks.devTaskId, task.devTaskId))
    .returning({ devTaskId: devTasks.devTaskId });
  if (updated.length === 0) throw new HdwError('not_found');
  if (changed)
    await writeAudit(tx, {
      action: 'devtask.status_changed',
      objectType: 'dev_task',
      objectId: task.devTaskId,
      diff: { from: task.status, to: change.status, ...(version && version !== task.version ? { version } : {}) },
    });
  if (!closed || task.closedNotifiedOn !== null) return { changed, reminded: 0 };
  const links = await tx.select({ ticketId: devTaskLinks.ticketId, ideaId: devTaskLinks.ideaId }).from(devTaskLinks).where(eq(devTaskLinks.devTaskId, task.devTaskId));
  const closedTask = { ref: task.externalId, status: change.status, version };
  const reminded = await devTaskClosedTx(tx, links.flatMap((link) => (link.ticketId ? [link.ticketId] : [])), closedTask, actor);
  // Идеи этой задачи (план M7, решение 18): статус идеи не меняется, модуль идей уведомляет роль product.
  const ideaIds = links.flatMap((link) => (link.ideaId ? [link.ideaId] : []));
  const ideasNotified = ideaIds.length > 0 ? await ideaDevTaskClosedTx(tx, ideaIds, closedTask) : 0;
  return { changed, reminded: reminded + ideasNotified };
}
