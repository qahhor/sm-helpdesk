'use server';

import { redirect } from 'next/navigation';
import { getLocale } from 'next-intl/server';
import { isHdpError } from '@/modules/hdp/api';
import { endAnnouncement, requestAnnouncementTranslation, saveAnnouncement, saveAnnouncementTranslation } from '@/modules/hdp/api/announcements';
import { requireStaffActor } from '@/modules/hdu/api';

// Действия страницы объявлений (план M5c, задача 6): права (care, admin), период, аудиторию и проверку текста делает
// модуль hdp и ещё раз база; страница получает итог отметкой в адресе. Время из полей datetime-local считается
// временем Ташкента (время поддержки), смещение +05:00 добавляет действие.

const text = (form: FormData, name: string) => String(form.get(name) ?? '');
/** Поле datetime-local без пояса: время поддержки (Ташкент, UTC+5 без перехода на летнее время). */
const tashkent = (value: string) => (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value) ? `${value}:00+05:00` : value);

async function run(action: () => Promise<unknown>, done: string): Promise<never> {
  const locale = await getLocale();
  let status = done;
  let kinds = '';
  try {
    await action();
  } catch (error) {
    if (!isHdpError(error)) throw error;
    status = `error-${error.code}`;
    if (error.findings.length > 0) kinds = `&kinds=${[...new Set(error.findings.map((f) => f.kind))].join(',')}`;
  }
  redirect(`/${locale}/agent/announcements?status=${status}${kinds}`);
}

export async function saveAnnouncementAction(form: FormData): Promise<void> {
  const staff = await requireStaffActor();
  const audience = text(form, 'audience');
  await run(
    () =>
      saveAnnouncement(staff, {
        ...(text(form, 'announcementId') ? { announcementId: text(form, 'announcementId') } : {}),
        kind: text(form, 'kind'),
        audience,
        serverId: audience === 'server' ? text(form, 'serverId') || null : null,
        moduleId: audience === 'module' ? text(form, 'moduleId') || null : null,
        startsOn: tashkent(text(form, 'startsOn')),
        endsOn: tashkent(text(form, 'endsOn')),
        locale: text(form, 'locale'),
        title: text(form, 'title'),
        body: text(form, 'body'),
      }),
    'saved',
  );
}

export async function endAnnouncementAction(form: FormData): Promise<void> {
  const staff = await requireStaffActor();
  await run(() => endAnnouncement(staff, { announcementId: text(form, 'announcementId') }), 'ended');
}

export async function announcementTranslationAction(form: FormData): Promise<void> {
  const staff = await requireStaffActor();
  await run(
    () =>
      saveAnnouncementTranslation(staff, {
        announcementId: text(form, 'announcementId'),
        locale: text(form, 'locale'),
        title: text(form, 'title'),
        body: text(form, 'body'),
        acceptMachine: text(form, 'accept') === 'true',
      }),
    'translation',
  );
}

export async function requestAnnouncementTranslationAction(form: FormData): Promise<void> {
  const staff = await requireStaffActor();
  await run(() => requestAnnouncementTranslation(staff, { announcementId: text(form, 'announcementId'), locale: text(form, 'locale') }), 'translating');
}
