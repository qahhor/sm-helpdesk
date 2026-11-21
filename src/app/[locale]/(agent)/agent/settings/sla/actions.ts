'use server';

import { redirect } from 'next/navigation';
import { getLocale } from 'next-intl/server';
import { isHdrError, saveCalendar, saveHolidays, saveSlaPolicy } from '@/modules/hdr/api';
import { requireStaffActor, type StaffContext } from '@/modules/hdu/api';

// Действия раздела "Сроки и рабочее время" (FR-SLA-01, FR-SLA-12). Права и значения проверяет модуль hdr,
// итог показывается кодом в адресе страницы.

async function run(action: (staff: StaffContext) => Promise<void>, done: string): Promise<never> {
  const staff = await requireStaffActor({ roles: ['admin'] });
  const page = `/${await getLocale()}/agent/settings/sla`;
  try {
    await action(staff);
  } catch (error) {
    if (!isHdrError(error)) throw error;
    redirect(`${page}?error=${error.code}`);
  }
  redirect(`${page}?done=${done}`);
}

const text = (form: FormData, name: string) => String(form.get(name) ?? '').trim();

/** Сроки одного приоритета: решение в минутах (P1, P2) или в рабочих днях (P3, P4). */
export async function saveSlaPolicyAction(form: FormData): Promise<void> {
  await run(async (staff) => {
    const kind = text(form, 'resolutionKind');
    await saveSlaPolicy(staff, {
      priority: text(form, 'priority'),
      firstResponseMinutes: text(form, 'firstResponseMinutes'),
      clock: text(form, 'clock'),
      ...(kind === 'days' ? { resolutionDays: text(form, 'resolutionValue') } : { resolutionMinutes: text(form, 'resolutionValue') }),
    });
  }, 'policy');
}

/** Часовой пояс и график недели: у рабочего дня отмечен флажок и заданы время начала и конца. */
export async function saveCalendarAction(form: FormData): Promise<void> {
  await run(async (staff) => {
    const week = Object.fromEntries(
      [0, 1, 2, 3, 4, 5, 6].map((day) => [day, form.get(`on${day}`) === 'on' ? [text(form, `from${day}`), text(form, `to${day}`)] : null]),
    );
    await saveCalendar(staff, { timeZone: text(form, 'timeZone'), week });
  }, 'calendar');
}

/** Праздники года: даты ГГГГ-ММ-ДД через пробел, запятую или с новой строки. */
export async function saveHolidaysAction(form: FormData): Promise<void> {
  await run(async (staff) => {
    const dates = text(form, 'dates')
      .split(/[\s,;]+/u)
      .filter((value) => value !== '');
    await saveHolidays(staff, { year: text(form, 'year'), dates });
  }, 'holidays');
}
