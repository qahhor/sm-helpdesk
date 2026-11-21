'use server';

import { redirect } from 'next/navigation';
import { getLocale } from 'next-intl/server';
import { loadSlaConfig } from '@/modules/hdr/api';
import {
  assignTicket,
  isHdtError,
  setPriority,
  setStatus,
  setTicketModule,
  setTicketType,
  type SnoozePreset,
  snoozeTarget,
  snoozeTicket,
  takeTicket,
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
