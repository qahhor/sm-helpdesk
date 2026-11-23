import { getPlaybook, listActiveModules, listTemplates } from '@/modules/hdr/api';
import { DEVELOPMENT_ROLES, getAgentTicket, HDT_ERROR_CODES, loadDraft, QUEUE_KEYS, QUEUE_SORTS, TRANSFERABLE_STATUSES } from '@/modules/hdt/api';
import { listAssignableStaff, type StaffContext } from '@/modules/hdu/api';

// Данные страницы обращения у сотрудника: обращение с историей, справочники для действий, права на передачу
// между линиями, итог прошлого действия из адреса. Вынесено из страницы (аудит 23.11.2026, находка A8): загрузка
// данных и права отдельно от разметки.

/** Коды "сделано" в адресе страницы после действия. */
export const DONE = ['taken', 'assigned', 'status', 'priority', 'type', 'module', 'snoozed', 'sent', 'noted', 'transferred', 'returned', 'merged', 'created', 'invited'] as const;

export type TicketPageSearch = { done?: string; error?: string; queue?: string; sort?: string; shown?: string };

/** Всё, что нужно странице. Нет обращения с таким номером: null (страница отвечает "не найдено"). */
export async function loadTicketPage(staff: StaffContext, raw: string | null, search: TicketPageSearch, locale: string) {
  const ticket = raw ? await getAgentTicket(staff, raw, { shown: search.shown }) : null;
  if (!ticket) return null;
  const canWrite = staff.actor.staffRole !== 'product';
  const [assignable, modules, draft, templates] = canWrite
    ? await Promise.all([listAssignableStaff(staff), listActiveModules(staff.actor, locale), loadDraft(staff, ticket.number), listTemplates(staff, { moduleId: ticket.moduleId })])
    : [[], [], null, []];
  // Линии (FR-LINE-03, 04): передать может тот, кто ведёт обращения, с первой линии; вернуть вторая линия, care, admin.
  const canTransfer = canWrite && ticket.line === 'l1' && TRANSFERABLE_STATUSES.includes(ticket.status);
  const canReturn =
    (DEVELOPMENT_ROLES as readonly string[]).includes(staff.actor.staffRole) && ticket.line !== 'l1' && ticket.status !== 'resolved' && ticket.status !== 'closed';
  const playbook = canTransfer ? await getPlaybook(staff.actor, { moduleId: ticket.moduleId, type: ticket.type }) : null;
  return {
    ticket,
    canWrite,
    assignable,
    modules,
    draft,
    templates,
    canTransfer,
    canReturn,
    playbook,
    // Очередь и сортировка, из которых открыто обращение (FR-AG-17): по ним "Отправить и к следующему".
    fromQueue: QUEUE_KEYS.find((key) => key === search.queue) ?? 'mine',
    fromSort: QUEUE_SORTS.find((key) => key === search.sort) ?? 'sla',
    done: DONE.find((code) => code === search.done),
    error: HDT_ERROR_CODES.find((code) => code === search.error),
  };
}
