import 'server-only';
import * as z from 'zod';
import { withActor } from '@/db/with-actor';
import { getEnv } from '@/env';
import { logEvent } from '@/lib/log';
import { type StaffContext, wakeAutomation, writeAudit } from '@/modules/hdc/api';
import { wakeOutbox } from '@/modules/hdn/api/outbox';
import type { Tx } from '@/db/client';
import { problemForDevTaskTx } from '@/modules/hdp/api/dev-task';
import { devHandOverSourceTx, devHandOverTx, devLockTicketTx, devTaskHistoryTx, devTicketRefTx } from '@/modules/hdt/api/dev-tasks';
import { DEVELOPMENT_ROLES } from '@/modules/hdt/pref';
import { LOOPBACK_HOSTS } from '@/security/outbound';
import { devTaskUrlOrNull } from '../dev-task-url';
import { applyDevTaskStatusTx, type DevTask, devTaskByRefTx, devTaskOfProblemTx, devTaskOfTicketTx, type LinkInput, linkProblemTx, linkTicketTx, lockDevTaskTx, unlinkProblemTx, unlinkTicketTx } from '../core/dev-tasks';
import { devTrackerMode, getDevTracker } from '../dev-tracker';
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
// Режим API (задача 8): портал создаёт задачу в таск-менеджере Smartup сам, статус задачи приходит вебхуком и
// опросом, вручную его не меняют. Реализация для API это заготовка против предполагаемого договора
// (docs/integrations/dev-tracker.md).
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
/** Режим API: только обращение и, если нужно привязать существующую задачу, её номер. Ссылку и название даёт таск-менеджер. */
const apiInput = z.strictObject({ ticketNumber, externalId: externalId.optional() });
const unlinkInput = z.strictObject({ ticketNumber });
const statusInput = z.strictObject({
  devTaskId: z.uuid(),
  status: z.enum(DEV_TASK_STATUSES),
  version: z.string().trim().min(1).max(DEV_TASK_VERSION_MAX).optional(),
});

/** Портал сам работает на localhost (разработка и тесты): тогда ссылкой на задачу может быть http на localhost. */
const localPortal = (): boolean => LOOPBACK_HOSTS.has(new URL(getEnv().HUB_URL).hostname);

/**
 * Привязка и статус одной транзакцией: обращение заблокировано, задача найдена или создана, привязка поставлена,
 * статус "В разработке" поставлен действием сотрудника, внутренняя запись истории и запись журнала. При любом
 * отказе не остаётся ничего.
 */
async function linkAndHandOver(ctx: StaffContext, number: number, link: LinkInput): Promise<{ devTaskId: string; created: boolean }> {
  const result = await withActor(ctx.actor, async (tx) => {
    const ticket = await devLockTicketTx(tx, ctx.actor, number);
    const { task, created } = await linkTicketTx(tx, ticket, link);
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

/**
 * Передать обращение в разработку. Отказы: forbidden (роль), invalid_input, invalid_url, not_found (нет обращения),
 * already_linked, task_closed, transition_refused и merged (из модуля обращений: из этого статуса перехода нет).
 *
 * Ручной режим: номер, ссылка и название задачи из формы. Режим API: портал создаёт задачу в таск-менеджере Smartup
 * (или находит существующую по номеру) и привязывает обращение; отказы task_not_found и tracker_unavailable.
 */
export async function sendToDevelopment(ctx: StaffContext, input: unknown): Promise<{ devTaskId: string; created: boolean }> {
  requireDeveloper(ctx);
  if (devTrackerMode() === 'smartup') return sendViaTracker(ctx, parse(apiInput, input));
  const data = parse(manualInput, input);
  const url = devTaskUrlOrNull(data.url, localPortal());
  if (!url) throw new HdwError('invalid_url');
  return linkAndHandOver(ctx, data.ticketNumber, { tracker: 'manual', externalId: data.externalId, url, title: data.title });
}

/** Адрес обращения в рабочем месте сотрудника: по нему разработчик возвращается из задачи к обращению. */
const ticketUrl = (number: number): string => `${getEnv().HUB_URL}/ru/agent/tickets/SUP-${number}`;

/**
 * Режим API (FR-DEV-03; план M8, задача 8). Порядок без половинчатых состояний: сначала проверка роли, статуса и
 * привязки, затем запрос к таск-менеджеру вне транзакции, затем привязка и статус одной транзакцией. Таск-менеджер
 * не ответил: отказ tracker_unavailable, обращение не тронуто, сотрудник повторяет позже. Транзакция не прошла
 * после создания задачи: номер осиротевшей задачи пишется в журнал событием devtask.orphan.
 *
 * В таск-менеджер уходит текст клиента: тема и описание обращения. Это внутренняя система Smartup, и ТЗ этого
 * требует (FR-DEV-03). Вложения и переписка не уходят.
 */
async function sendViaTracker(ctx: StaffContext, data: { ticketNumber: number; externalId?: string | undefined }): Promise<{ devTaskId: string; created: boolean }> {
  const { source, known } = await withActor(ctx.actor, async (tx) => {
    const ticket = await devHandOverSourceTx(tx, ctx.actor, data.ticketNumber);
    if (await devTaskOfTicketTx(tx, ticket.ticketId)) throw new HdwError('already_linked');
    return { source: ticket, known: data.externalId ? await devTaskByRefTx(tx, 'smartup', data.externalId) : null };
  });
  const tracker = getDevTracker();

  // Задача уже известна порталу: таск-менеджер не нужен, обращение привязывается к ней же (FR-DEV-06).
  if (known) return linkAndHandOver(ctx, source.number, { tracker: 'smartup', externalId: known.externalId, url: known.url, title: known.title });

  if (data.externalId) {
    let remote: Awaited<ReturnType<typeof tracker.getTask>>;
    try {
      remote = await tracker.getTask(data.externalId);
    } catch {
      // Причина уже в журнале событий (реализация пишет её кодом): сотруднику один понятный отказ.
      throw new HdwError('tracker_unavailable');
    }
    if (!remote) throw new HdwError('task_not_found');
    const url = devTaskUrlOrNull(remote.url, localPortal());
    if (!url) throw new HdwError('tracker_unavailable');
    // Названия задачи API не отдаёт: оно остаётся пустым, блок на странице показывает номер и ссылку.
    return linkAndHandOver(ctx, source.number, { tracker: 'smartup', externalId: remote.ref, url, title: '', status: remote.status, version: remote.version ?? null });
  }

  const sourceUrl = ticketUrl(source.number);
  let created: { ref: string; url: string };
  try {
    created = await tracker.createTask({
      title: source.title,
      // Ссылка на обращение строкой без слов: текст задачи читают в таск-менеджере, а не в портале.
      descriptionMd: `${source.description}\n\n---\nSmartup Hub: ${sourceUrl}`,
      kind: source.type === 'bug' ? 'bug' : 'feature',
      priority: source.priority,
      ...(source.moduleCode ? { moduleCode: source.moduleCode } : {}),
      sourceUrl,
    });
  } catch {
    throw new HdwError('tracker_unavailable');
  }
  try {
    const url = devTaskUrlOrNull(created.url, localPortal());
    if (!url) throw new HdwError('tracker_unavailable');
    return await linkAndHandOver(ctx, source.number, { tracker: 'smartup', externalId: created.ref, url, title: source.title.trim().slice(0, DEV_TASK_TITLE_MAX).trim() });
  } catch (error) {
    // Задача в таск-менеджере создана, а привязка не прошла (обращение успели изменить, сбой базы): номер задачи
    // остаётся в журнале событий, чтобы её нашли и закрыли или привязали вручную. Текста обращения в записи нет.
    logEvent('error', 'devtask.orphan', { ref: created.ref, ticketNumber: source.number });
    throw error;
  }
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

// --- Задача разработки у известной проблемы (ТЗ FR-KP-11, FR-DEV-06; план M5c, задача 8, решение 25) ---

const problemNumber = z.number().int().positive().max(999_999_999_999);
const problemManualInput = z.strictObject({ problemNumber, externalId, url: z.string().max(4000), title: z.string().trim().min(1).max(DEV_TASK_TITLE_MAX) });
const problemApiInput = z.strictObject({ problemNumber, externalId: externalId.optional() });

/** Привязка задачи к проблеме одной транзакцией: проблема заблокирована, задача найдена или создана, журнал аудита. */
async function linkProblem(ctx: StaffContext, number: number, link: LinkInput): Promise<{ devTaskId: string; created: boolean }> {
  return withActor(ctx.actor, async (tx) => {
    const problem = await problemForDevTaskTx(tx, number, { lock: true });
    const { task, created } = await linkProblemTx(tx, problem.problemId, link);
    // В журнале номер задачи без адреса: в адресе бывают ключи доступа.
    await writeAudit(tx, { action: 'devtask.linked', objectType: 'known_problem', objectId: problem.problemId, diff: { devTaskId: task.devTaskId, tracker: task.tracker, ref: task.externalId, created } });
    return { devTaskId: task.devTaskId, created };
  });
}

/**
 * Привязать известную проблему к задаче разработки, существующей или новой (решение 25). Те же роли и тот же порядок,
 * что у передачи обращения: ручной режим берёт номер, ссылку и название из формы; режим API находит задачу по номеру
 * или создаёт её в таск-менеджере из внутреннего названия проблемы (это внутренняя система Smartup; публичный текст и
 * обращения клиентов туда не уходят). Отказы: forbidden, invalid_input, invalid_url, not_found, already_linked,
 * task_closed, task_not_found, tracker_unavailable. Статус проблемы не меняется.
 */
export async function linkDevTaskToProblem(ctx: StaffContext, input: unknown): Promise<{ devTaskId: string; created: boolean }> {
  requireDeveloper(ctx);
  if (devTrackerMode() !== 'smartup') {
    const data = parse(problemManualInput, input);
    const url = devTaskUrlOrNull(data.url, localPortal());
    if (!url) throw new HdwError('invalid_url');
    return linkProblem(ctx, data.problemNumber, { tracker: 'manual', externalId: data.externalId, url, title: data.title });
  }
  const data = parse(problemApiInput, input);
  const { problem, known } = await withActor(ctx.actor, async (tx) => {
    const found = await problemForDevTaskTx(tx, data.problemNumber);
    if (await devTaskOfProblemTx(tx, found.problemId)) throw new HdwError('already_linked');
    return { problem: found, known: data.externalId ? await devTaskByRefTx(tx, 'smartup', data.externalId) : null };
  });
  if (known) return linkProblem(ctx, problem.number, { tracker: 'smartup', externalId: known.externalId, url: known.url, title: known.title });
  const tracker = getDevTracker();
  if (data.externalId) {
    let remote: Awaited<ReturnType<typeof tracker.getTask>>;
    try {
      remote = await tracker.getTask(data.externalId);
    } catch {
      throw new HdwError('tracker_unavailable');
    }
    if (!remote) throw new HdwError('task_not_found');
    const url = devTaskUrlOrNull(remote.url, localPortal());
    if (!url) throw new HdwError('tracker_unavailable');
    return linkProblem(ctx, problem.number, { tracker: 'smartup', externalId: remote.ref, url, title: '', status: remote.status, version: remote.version ?? null });
  }
  const sourceUrl = `${getEnv().HUB_URL}/ru/agent/problems/${problem.number}`;
  let created: { ref: string; url: string };
  try {
    created = await tracker.createTask({ title: problem.internalTitle, descriptionMd: `${problem.internalTitle}\n\n---\nSmartup Hub: ${sourceUrl}`, kind: 'bug', sourceUrl });
  } catch {
    throw new HdwError('tracker_unavailable');
  }
  try {
    const url = devTaskUrlOrNull(created.url, localPortal());
    if (!url) throw new HdwError('tracker_unavailable');
    return await linkProblem(ctx, problem.number, { tracker: 'smartup', externalId: created.ref, url, title: problem.internalTitle.trim().slice(0, DEV_TASK_TITLE_MAX).trim() });
  } catch (error) {
    logEvent('error', 'devtask.orphan', { ref: created.ref, problemNumber: problem.number });
    throw error;
  }
}

/** Снять привязку проблемы к задаче. Привязки нет: not_found. Задача остаётся. */
export async function unlinkDevTaskFromProblem(ctx: StaffContext, input: unknown): Promise<void> {
  requireDeveloper(ctx);
  const data = parse(z.strictObject({ problemNumber }), input);
  await withActor(ctx.actor, async (tx) => {
    const problem = await problemForDevTaskTx(tx, data.problemNumber, { lock: true });
    const task = await unlinkProblemTx(tx, problem.problemId);
    if (!task) throw new HdwError('not_found');
    await writeAudit(tx, { action: 'devtask.unlinked', objectType: 'known_problem', objectId: problem.problemId, diff: { devTaskId: task.devTaskId, tracker: task.tracker, ref: task.externalId } });
  });
}

/** Задача разработки проблемы для карточки. Читает любой сотрудник. Нет проблемы или привязки: null. */
export async function readDevTaskForProblem(ctx: StaffContext, number: unknown): Promise<DevTaskView | null> {
  if (ctx.actor.type !== 'staff') throw new HdwError('forbidden');
  const parsed = problemNumber.safeParse(number);
  if (!parsed.success) return null;
  return withActor(ctx.actor, async (tx) => {
    const problem = await problemForDevTaskTx(tx, parsed.data).catch(() => null);
    if (!problem) return null;
    const found = await devTaskOfProblemTx(tx, problem.problemId);
    if (!found) return null;
    const { closedNotifiedOn: _closedNotifiedOn, ...task } = found;
    void _closedNotifiedOn;
    return { task, otherTickets: [] };
  });
}

/** Версия задачи разработки проблемы для итога закрытия fixed_in_version (решения 20, 25). Подключает src/wiring.ts. */
export async function devTaskVersionOfProblemTx(tx: Tx, problemId: string): Promise<string | null> {
  return (await devTaskOfProblemTx(tx, problemId))?.version ?? null;
}
