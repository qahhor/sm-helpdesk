'use server';

import { redirect } from 'next/navigation';
import { getLocale } from 'next-intl/server';
import { isHdrError, saveTemplate } from '@/modules/hdr/api';
import { requireStaffActor } from '@/modules/hdu/api';

// Сохранение шаблона ответа (FR-AG-06). Права и данные проверяет модуль hdr, итог показывается кодом в адресе.

const text = (form: FormData, name: string) => String(form.get(name) ?? '');

export async function saveTemplateAction(form: FormData): Promise<void> {
  const staff = await requireStaffActor({ roles: ['admin'] });
  const page = `/${await getLocale()}/agent/settings/templates`;
  const templateId = text(form, 'templateId').trim();
  const moduleId = text(form, 'moduleId').trim();
  try {
    await saveTemplate(staff, {
      ...(templateId ? { templateId } : {}),
      shortcut: text(form, 'shortcut'),
      title: text(form, 'title'),
      body: { ru: text(form, 'bodyRu'), uz: text(form, 'bodyUz'), en: text(form, 'bodyEn') },
      moduleId: moduleId || null,
      isEnabled: form.get('isEnabled') === 'on',
    });
  } catch (error) {
    if (!isHdrError(error)) throw error;
    redirect(`${page}?error=${error.code}`);
  }
  redirect(`${page}?done=saved`);
}
