import { getPlaybook, listActiveModules, listTags, listTemplates } from '@/modules/hdr/api';
import { DEVELOPMENT_ROLES, getAgentTicket, HDT_ERROR_CODES, loadDraft, QUEUE_KEYS, QUEUE_SORTS, TRANSFERABLE_STATUSES } from '@/modules/hdt/api';
import { listAssignableStaff, type StaffContext } from '@/modules/hdu/api';
import { DEV_TASK_ERROR_CODES, devTrackerMode, listRunnableMacros, readDevTaskForTicket } from '@/modules/hdw/api';

// Данные страницы обращения у сотрудника: обращение с историей, справочники для действий, права на передачу
// между линиями, итог прошлого действия из адреса. Вынесено из страницы (аудит 23.11.2026, находка A8): загрузка
// данных и права отдельно от разметки.

/** Коды "сделано" в адресе страницы после действия. */
export const DONE = ['taken', 'assigned', 'status', 'priority', 'type', 'module', 'snoozed', 'sent', 'noted', 'transferred', 'returned', 'merged', 'created', 'invited', 'tagged', 'untagged', 'dev_sent', 'dev_unlinked', 'dev_status', 'triaged', 'flagged'] as const;

/** Отказы создания решения из обращения (план M5, задача 7): код модуля решений с приставкой solution_. */
const SOLUTION_ERROR_CODES = ['solution_not_resolved', 'solution_forbidden', 'solution_not_found', 'solution_invalid_input'] as const;

export type TicketPageSearch = { done?: string; error?: string; ch?: string; queue?: string; sort?: string; shown?: string };

/** Всё, что нужно странице. Нет обращения с таким номером: null (страница отвечает "не найдено"). */
export async function loadTicketPage(staff: StaffContext, raw: string | null, search: TicketPageSearch, locale: string) {
  const ticket = raw ? await getAgentTicket(staff, raw, { shown: search.shown }) : null;
  if (!ticket) return null;
  const canWrite = staff.actor.staffRole !== 'product';
  const [assignable, modules, draft, templates, knownTags, macros] = canWrite
    ? await Promise.all([
        listAssignableStaff(staff),
        listActiveModules(staff.actor, locale),
        loadDraft(staff, ticket.number),
        listTemplates(staff, { moduleId: ticket.moduleId }),
        // Справочник тегов: подсказки в поле постановки тега (FR-AUTO-13).
        listTags(staff),
        // Включённые макросы для меню "Макросы" (FR-AG-15).
        listRunnableMacros(staff),
      ])
    : [[], [], null, [], [], []];
  // Линии (FR-LINE-03, 04): передать может тот, кто ведёт обращения, с первой линии; вернуть вторая линия, care, admin.
  const canTransfer = canWrite && ticket.line === 'l1' && TRANSFERABLE_STATUSES.includes(ticket.status);
  const canReturn =
    (DEVELOPMENT_ROLES as readonly string[]).includes(staff.actor.staffRole) && ticket.line !== 'l1' && ticket.status !== 'resolved' && ticket.status !== 'closed';
  const playbook = canTransfer ? await getPlaybook(staff.actor, { moduleId: ticket.moduleId, type: ticket.type }) : null;
  // Задача разработки (FR-DEV): блок читают все сотрудники; передать, отвязать и сменить статус задачи могут вторая
  // линия, care и admin. Кнопка "Передать в разработку" есть, когда переход разрешён (из "В работе") или обращение
  // уже "В разработке", но ещё без задачи.
  const devTask = await readDevTaskForTicket(staff, ticket.number);
  const canDevelop = (DEVELOPMENT_ROLES as readonly string[]).includes(staff.actor.staffRole);
  const canHandOver = canDevelop && !devTask && ticket.mergedInto === null && (ticket.status === 'in_progress' || ticket.status === 'in_development');
  return {
    ticket,
    canWrite,
    assignable,
    modules,
    draft,
    templates,
    knownTags,
    macros,
    canTransfer,
    canReturn,
    playbook,
    devTask,
    canDevelop,
    canHandOver,
    devMode: devTrackerMode(),
    // Очередь и сортировка, из которых открыто обращение (FR-AG-17): по ним "Отправить и к следующему".
    fromQueue: QUEUE_KEYS.find((key) => key === search.queue) ?? 'mine',
    fromSort: QUEUE_SORTS.find((key) => key === search.sort) ?? 'sla',
    done: DONE.find((code) => code === search.done),
    error: [...HDT_ERROR_CODES, ...DEV_TASK_ERROR_CODES, ...SOLUTION_ERROR_CODES].find((code) => code === search.error),
    // Сводка "что изменилось" для ошибки changed: три числа из адреса, ничего кроме чисел не принимается.
    changed: changedOf(search.ch),
  };
}

/** Сводка изменений из адреса страницы: "сообщений.статус.исполнитель", например "2.1.0". */
function changedOf(raw: string | undefined): { newMessages: number; statusChanged: boolean; assigneeChanged: boolean } | null {
  const match = /^(\d{1,4})\.([01])\.([01])$/.exec(raw ?? '');
  return match ? { newMessages: Number(match[1]), statusChanged: match[2] === '1', assigneeChanged: match[3] === '1' } : null;
}
