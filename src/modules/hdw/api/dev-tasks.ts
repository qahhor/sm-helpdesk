import 'server-only';
import * as z from 'zod';
import { withActor } from '@/db/with-actor';
import { getEnv } from '@/env';
import { type StaffContext, wakeAutomation, writeAudit } from '@/modules/hdc/api';
import { wakeOutbox } from '@/modules/hdn/api/outbox';
import { devHandOverTx, devLockTicketTx, devTaskHistoryTx, devTicketRefTx } from '@/modules/hdt/api/dev-tasks';
import { DEVELOPMENT_ROLES } from '@/modules/hdt/pref';
import { LOOPBACK_HOSTS } from '@/security/outbound';
import { devTaskUrlOrNull } from '../dev-task-url';
import { applyDevTaskStatusTx, type DevTask, devTaskOfTicketTx, linkTicketTx, lockDevTaskTx, unlinkTicketTx } from '../core/dev-tasks';
import { HdwError } from '../error';
import { DEV_TASK_REF_MAX, DEV_TASK_STATUSES, DEV_TASK_TITLE_MAX, DEV_TASK_VERSION_MAX } from '../pref';

// Модуль hdw, слой api: передача обращения в разработку (ТЗ 7.9, FR-DEV-01, 02, 05, 06, сценарий S4; план M8,
// задача 7, решение 12).
//
// Передают, отвязывают и меняют статус задачи роли, которым разрешён статус "В разработке": вторая линия, Customer
// Care и администратор (ТЗ 5.2). Читают задачу обращения все сотрудники. Клиенту о задаче не отдаётся ничего: ему
// виден только статус обращения.
//
// Ручной режим: сотрудник вводит номер, ссылку и название задачи. Задача с таким номером уже есть: обращение
// привязывается к ней, адрес и название из формы не берутся (FR-DEV-06). Статус "В разработке" ставит обычное
// действие сотрудника из модуля обращений, в той же транзакции, что и привязка: переход по таблице 7.2, история,
// журнал, сроки, событие для правил и письмо клиенту те же, что при ручной смене статуса.
//
// Адрес задачи портал не открывает: он только показывается сотруднику внешней ссылкой. Поэтому узел не проверяется
// на "внешний" (таск-менеджер бывает во внутренней сети), проверяется схема: https, а http только для localhost
// и только когда сам портал работает на localhost, как у адресов вебхуков.

export type { DevTask } from '../core/dev-tasks';
export { devTrackerMode } from '../dev-tracker';
export { DEV_TASK_REF_MAX, DEV_TASK_STATUSES, DEV_TASK_TITLE_MAX, DEV_TASK_URL_MAX, DEV_TASK_VERSION_MAX, type DevTaskStatus, type DevTrackerKind } from '../pref';

/** Коды отказов передачи в разработку, которые страница показывает своим текстом. */
export const DEV_TASK_ERROR_CODES = ['invalid_url', 'already_linked', 'task_closed', 'not_manual', 'task_not_found', 'tracker_unavailable'] as const;

function requireDeveloper(ctx: StaffContext): void {
  if (ctx.actor.type !== 'staff' || !(DEVELOPMENT_ROLES as readonly string[]).includes(ctx.actor.staffRole)) throw new HdwError('forbidden');
}

function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const parsed = schema.safeParse(input);
  if (!parsed.success) throw new HdwError('invalid_input');
  return parsed.data;
}

const ticketNumber = z.number().int().positive().max(999_999_999_999);
/** Номер задачи: без пробелов и управляющих знаков, как его показывает таск-менеджер (например, DEV-501). */
const externalId = z
  .string()
  .trim()
  .min(1)
  .max(DEV_TASK_REF_MAX)
  .regex(/^[^\s\p{Cc}]+$/u);
const manualInput = z.strictObject({
  ticketNumber,
  externalId,
  // Адрес проверяется отдельно и получает свой код отказа: страница показывает, что именно не так.
  url: z.string().max(4000),
  title: z.string().trim().min(1).max(DEV_TASK_TITLE_MAX),
});
const unlinkInput = z.strictObject({ ticketNumber });
const statusInput = z.strictObject({
  devTaskId: z.uuid(),
  status: z.enum(DEV_TASK_STATUSES),
  version: z.string().trim().min(1).max(DEV_TASK_VERSION_MAX).optional(),
});

/** Портал сам работает на localhost (разработка и тесты): тогда ссылкой на задачу может быть http на localhost. */
const localPortal = (): boolean => LOOPBACK_HOSTS.has(new URL(getEnv().HUB_URL).hostname);

/**
 * Передать обращение в разработку. Отказы: forbidden (роль), invalid_input, invalid_url, not_found (нет обращения),
 * already_linked, task_closed, transition_refused и merged (из модуля обращений: из этого статуса перехода нет).
 * При любом отказе не остаётся ничего: задача, привязка, статус и история пишутся одной транзакцией.
 */
export async function sendToDevelopment(ctx: StaffContext, input: unknown): Promise<{ devTaskId: string; created: boolean }> {
  requireDeveloper(ctx);
  const data = parse(manualInput, input);
  const url = devTaskUrlOrNull(data.url, localPortal());
  if (!url) throw new HdwError('invalid_url');
  const result = await withActor(ctx.actor, async (tx) => {
    const ticket = await devLockTicketTx(tx, ctx.actor, data.ticketNumber);
    const { task, created } = await linkTicketTx(tx, ticket, { tracker: 'manual', externalId: data.externalId, url, title: data.title });
    await devHandOverTx(tx, ctx.actor, ticket);
    await devTaskHistoryTx(tx, ticket, ctx.actor, { action: 'linked', devTaskId: task.devTaskId, ref: task.externalId });
    // В журнале номер задачи без адреса: в адресе бывают ключи доступа.
    await writeAudit(tx, {
      action: 'devtask.linked',
      objectType: 'ticket',
      objectId: ticket.ticketId,
      orgId: ticket.orgId,
      diff: { devTaskId: task.devTaskId, tracker: task.tracker, ref: task.externalId, created },
    });
    return { devTaskId: task.devTaskId, created };
  });
  // Письмо клиенту о статусе и событие для правил уже записаны: отправка и разбор будятся после фиксации.
  await wakeOutbox();
  await wakeAutomation();
  return result;
}

/** Снять привязку обращения к задаче. Статус обращения не меняется. Привязки нет: not_found. */
export async function unlinkFromDevelopment(ctx: StaffContext, input: unknown): Promise<void> {
  requireDeveloper(ctx);
  const data = parse(unlinkInput, input);
  await withActor(ctx.actor, async (tx) => {
    const ticket = await devLockTicketTx(tx, ctx.actor, data.ticketNumber);
    const task = await unlinkTicketTx(tx, ticket.ticketId);
    if (!task) throw new HdwError('not_found');
    await devTaskHistoryTx(tx, ticket, ctx.actor, { action: 'unlinked', devTaskId: task.devTaskId, ref: task.externalId });
    await writeAudit(tx, {
      action: 'devtask.unlinked',
      objectType: 'ticket',
      objectId: ticket.ticketId,
      orgId: ticket.orgId,
      diff: { devTaskId: task.devTaskId, tracker: task.tracker, ref: task.externalId },
    });
  });
}

/**
 * Сменить статус задачи вручную (ручной режим, решение 12). Задачу из API таск-менеджера сотрудник не меняет: её
 * статус приходит вебхуком и опросом (not_manual). Закрытие задачи напоминает исполнителям привязанных обращений.
 */
export async function setDevTaskStatus(ctx: StaffContext, input: unknown): Promise<void> {
  requireDeveloper(ctx);
  const data = parse(statusInput, input);
  const { reminded } = await withActor(ctx.actor, async (tx) => {
    const task = await lockDevTaskTx(tx, data.devTaskId);
    if (!task) throw new HdwError('not_found');
    if (task.tracker !== 'manual') throw new HdwError('not_manual');
    return applyDevTaskStatusTx(tx, task, { status: data.status, ...(data.version !== undefined ? { version: data.version } : {}) }, ctx.actor);
  });
  if (reminded > 0) await wakeOutbox();
}

export type DevTaskView = { task: Omit<DevTask, 'closedNotifiedOn'>; otherTickets: number[] };

/** Задача разработки обращения и номера других обращений той же задачи. Читает любой сотрудник. Нет привязки или обращения: null. */
export async function readDevTaskForTicket(ctx: StaffContext, number: unknown): Promise<DevTaskView | null> {
  if (ctx.actor.type !== 'staff') throw new HdwError('forbidden');
  const parsed = ticketNumber.safeParse(number);
  if (!parsed.success) return null;
  return withActor(ctx.actor, async (tx) => {
    const ticket = await devTicketRefTx(tx, parsed.data);
    if (!ticket) return null;
    const found = await devTaskOfTicketTx(tx, ticket.ticketId);
    if (!found) return null;
    const { closedNotifiedOn: _closedNotifiedOn, ...task } = found.task;
    void _closedNotifiedOn;
    return { task, otherTickets: found.otherTickets };
  });
}
