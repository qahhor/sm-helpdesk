'use server';

import { redirect } from 'next/navigation';
import { getLocale } from 'next-intl/server';
import { loadSlaConfig } from '@/modules/hdr/api';
import {
  assignTicket,
  type ChangeSummary,
  isHdtError,
  listPresence,
  mergeTicket,
  nextInQueue,
  parseNumber,
  postStaffMessage,
  type PresenceEntry,
  returnToL1,
  saveDraft,
  setPriority,
  setStatus,
  setTicketModule,
  setTicketType,
  type SnoozePreset,
  snoozeTarget,
  snoozeTicket,
  takeTicket,
  touchPresence,
  transferToL2,
  zonedToDate,
} from '@/modules/hdt/api';
import { requireStaffActor, type StaffContext } from '@/modules/hdu/api';

// Действия сотрудника на странице обращения (план M3, задача 7). Права, переходы и данные проверяет модуль hdt,
// итог показывается кодом в адресе страницы.

const text = (form: FormData, name: string) => String(form.get(name) ?? '').trim();

async function run(form: FormData, action: (staff: StaffContext, number: number) => Promise<void>, done: string): Promise<never> {
  const staff = await requireStaffActor();
  const number = Number(text(form, 'number'));
  const page = `/${await getLocale()}/agent/tickets/SUP-${Number.isInteger(number) ? number : 0}`;
  try {
    await action(staff, number);
  } catch (error) {
    if (!isHdtError(error)) throw error;
    // Кто взял обращение, страница покажет сама из текущего исполнителя: имя в адресе не передаётся.
    redirect(`${page}?error=${error.code}`);
  }
  redirect(`${page}?done=${done}`);
}

export async function takeAction(form: FormData): Promise<void> {
  await run(form, (staff, number) => takeTicket(staff, number), 'taken');
}

export async function assignAction(form: FormData): Promise<void> {
  await run(form, (staff, number) => assignTicket(staff, { number, assigneeId: text(form, 'assigneeId') || null }), 'assigned');
}

export async function statusAction(form: FormData): Promise<void> {
  await run(
    form,
    (staff, number) =>
      setStatus(staff, { number, to: text(form, 'to'), resolution: text(form, 'resolution') || undefined, version: text(form, 'version') || undefined }),
    'status',
  );
}

export async function priorityAction(form: FormData): Promise<void> {
  await run(form, (staff, number) => setPriority(staff, { number, priority: text(form, 'priority'), reason: text(form, 'reason') }), 'priority');
}

export async function typeAction(form: FormData): Promise<void> {
  await run(form, (staff, number) => setTicketType(staff, { number, type: text(form, 'type') }), 'type');
}

export async function moduleAction(form: FormData): Promise<void> {
  await run(form, (staff, number) => setTicketModule(staff, { number, moduleId: text(form, 'moduleId') || null }), 'module');
}

/** Отложить: быстрые варианты считаются в часовом поясе поддержки, своя дата вводится в нём же (UX-A-11). */
export async function snoozeAction(form: FormData): Promise<void> {
  await run(
    form,
    async (staff, number) => {
      const preset = text(form, 'preset');
      if (preset === 'clear') return snoozeTicket(staff, { number, until: null });
      const { timeZone } = (await loadSlaConfig(staff.actor)).calendar;
      let until: Date | null = null;
      try {
        until = ['hour', 'tomorrow', 'monday'].includes(preset) ? snoozeTarget(preset as SnoozePreset, new Date(), timeZone) : zonedToDate(text(form, 'until'), timeZone);
      } catch {
        until = null;
      }
      await snoozeTicket(staff, { number, until: until ? until.toISOString() : 'invalid' });
    },
    'snoozed',
  );
}

// --- Поле ответа, черновик, присутствие (план M3, задача 8) ---

export type ComposerState =
  | { status: 'idle' }
  | { status: 'changed'; changed: ChangeSummary; version: string }
  | { status: 'error'; code: string };

/**
 * Ответ клиенту или заметка. Ушло: страница открывается заново с отметкой. Обращение изменили другие: форма
 * показывает, что изменилось, и версию, с которой агент может отправить, уже зная об изменениях (UX-A-06).
 */
export async function staffMessageAction(_prev: ComposerState, form: FormData): Promise<ComposerState> {
  const staff = await requireStaffActor();
  const number = Number(text(form, 'number'));
  const internal = text(form, 'internal') === '1';
  // "Отправить и к следующему" (FR-AG-17): следующее берётся до отправки, пока текущее ещё стоит на своём месте в очереди.
  const wantNext = text(form, 'next') === '1';
  const context = { queue: text(form, 'queue') || 'mine', sort: text(form, 'sort') || 'sla' };
  let result: Awaited<ReturnType<typeof postStaffMessage>>;
  let next: number | null = null;
  try {
    if (wantNext) next = await nextInQueue(staff, { ...context, afterNumber: number });
    result = await postStaffMessage(staff, {
      number,
      body: String(form.get('body') ?? ''),
      internal,
      attachmentIds: form.getAll('attachmentIds').map(String),
      waitForClient: !internal && form.get('waitForClient') === 'on',
      seenVersion: text(form, 'acceptVersion') || text(form, 'seenVersion'),
    });
  } catch (error) {
    if (!isHdtError(error)) throw error;
    return { status: 'error', code: error.code };
  }
  if (!result.ok) return { status: 'changed', changed: result.changed, version: result.version };
  const locale = await getLocale();
  const back = new URLSearchParams(context).toString();
  if (wantNext) redirect(next ? `/${locale}/agent/tickets/SUP-${next}?${back}` : `/${locale}/agent/queues?${back}&done=queue_done`);
  redirect(`/${locale}/agent/tickets/SUP-${number}?done=${internal ? 'noted' : 'sent'}&${back}`);
}

/** Черновик из поля ответа: через секунду после ввода и при уходе со страницы (UX-A-07). */
export async function saveDraftAction(input: { number: number; body: string; internal: boolean }): Promise<{ ok: boolean }> {
  const staff = await requireStaffActor();
  try {
    await saveDraft(staff, input);
    return { ok: true };
  } catch (error) {
    if (!isHdtError(error)) throw error;
    return { ok: false };
  }
}

/** Отметка "открыл" или "печатает" и список коллег на этом обращении (решение 10). */
export async function presenceAction(input: { number: number; mode: 'viewing' | 'typing' }): Promise<PresenceEntry[]> {
  const staff = await requireStaffActor();
  try {
    await touchPresence(staff, input);
    return await listPresence(staff, input.number);
  } catch (error) {
    if (!isHdtError(error)) throw error;
    return [];
  }
}

// --- Передача между линиями (план M3, задача 9) ---

export async function transferAction(form: FormData): Promise<void> {
  await run(
    form,
    (staff, number) =>
      transferToL2(staff, {
        number,
        reason: text(form, 'reason'),
        checked: String(form.get('checked') ?? ''),
        needed: String(form.get('needed') ?? ''),
        checklist: form.getAll('checklist').map(String),
      }),
    'transferred',
  );
}

export async function returnAction(form: FormData): Promise<void> {
  await run(form, (staff, number) => returnToL1(staff, { number, explanation: String(form.get('explanation') ?? '') }), 'returned');
}

// --- Объединение дублей (план M3, задача 11) ---

/** Номер основного из "SUP-1042" или "1042". Непонятный номер сервис отклонит как invalid_input. */
export async function mergeAction(form: FormData): Promise<void> {
  await run(form, async (staff, number) => void (await mergeTicket(staff, { number, intoNumber: parseNumber(text(form, 'into')) ?? 'invalid' })), 'merged');
}
