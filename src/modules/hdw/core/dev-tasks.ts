import 'server-only';
import { and, asc, eq, ne, sql } from 'drizzle-orm';
import type { Tx } from '@/db/client';
import type { StaffActor } from '@/db/with-actor';
import { writeAudit } from '@/modules/hdc/api';
import { devTaskClosedTx, ticketNumbersTx } from '@/modules/hdt/api/dev-tasks';
import { HdwError } from '../error';
import { DEV_TASK_CLOSED, type DevTaskStatus, type DevTrackerKind } from '../pref';
import { devTaskLinks, devTasks } from '../schema';

// Модуль hdw, слой core: задачи разработки и привязки обращений (ТЗ 7.9, FR-DEV-02, 05, 06; план M8, задача 7).
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
 * Привязать обращение к задаче с этим номером; задачи нет: она создаётся (FR-DEV-06). У существующей задачи адрес
 * и название не меняются. Отказы: already_linked (у обращения уже есть задача), task_closed (задача закрыта:
 * напоминание по ней уже ушло, привязанное обращение осталось бы без него). Строку обращения вызывающий уже
 * заблокировал; создание задачи с одним номером идёт по одному под блокировкой транзакции.
 */
export async function linkTicketTx(tx: Tx, ticket: { ticketId: string; orgId: string }, input: LinkInput): Promise<{ task: DevTask; created: boolean }> {
  const [linked] = await tx.select({ linkId: devTaskLinks.linkId }).from(devTaskLinks).where(eq(devTaskLinks.ticketId, ticket.ticketId)).limit(1);
  if (linked) throw new HdwError('already_linked');
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
  await tx.insert(devTaskLinks).values({ orgId: ticket.orgId, devTaskId: task.devTaskId, ticketId: ticket.ticketId });
  return { task, created };
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
    .where(and(eq(devTaskLinks.devTaskId, row.devTaskId), ne(devTaskLinks.ticketId, ticketId)))
    .orderBy(asc(devTaskLinks.linkId))
    .limit(OTHER_TICKETS_MAX);
  const numbers = await ticketNumbersTx(tx, others.map((item) => item.ticketId));
  return { task: row, otherTickets: [...numbers.values()].sort((a, b) => a - b) };
}

/** Больше стольких "также привязаны" блок на странице обращения не показывает. */
const OTHER_TICKETS_MAX = 50;

export type StatusChange = { status: DevTaskStatus; version?: string | null; url?: string; synced?: boolean };

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
      ...(change.synced ? { syncedOn: sql`now()` } : {}),
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
  const links = await tx.select({ ticketId: devTaskLinks.ticketId }).from(devTaskLinks).where(eq(devTaskLinks.devTaskId, task.devTaskId));
  const reminded = await devTaskClosedTx(tx, links.map((link) => link.ticketId), { ref: task.externalId, status: change.status, version }, actor);
  return { changed, reminded };
}
