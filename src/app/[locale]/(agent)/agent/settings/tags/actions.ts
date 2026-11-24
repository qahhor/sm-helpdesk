'use server';

import { redirect } from 'next/navigation';
import { getLocale } from 'next-intl/server';
import { deleteTag, isHdrError, updateTag } from '@/modules/hdr/api';
import { requireStaffActor, type StaffContext } from '@/modules/hdu/api';

// Изменение и удаление тега (FR-AUTO-13). Права, свежий вход и данные проверяет модуль hdr, итог показывается кодом
// в адресе страницы.

const text = (form: FormData, name: string) => String(form.get(name) ?? '');

async function run(action: (staff: StaffContext) => Promise<void>, done: string): Promise<never> {
  const staff = await requireStaffActor({ roles: ['admin'] });
  const page = `/${await getLocale()}/agent/settings/tags`;
  try {
    await action(staff);
  } catch (error) {
    if (!isHdrError(error)) throw error;
    redirect(`${page}?error=${error.code}`);
  }
  redirect(`${page}?done=${done}`);
}

export async function updateTagAction(form: FormData): Promise<void> {
  await run((staff) => updateTag(staff, { tagId: text(form, 'tagId'), name: text(form, 'name'), color: text(form, 'color') }), 'saved');
}

export async function deleteTagAction(form: FormData): Promise<void> {
  await run((staff) => deleteTag(staff, { tagId: text(form, 'tagId') }), 'deleted');
}
