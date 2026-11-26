'use server';

import { redirect } from 'next/navigation';
import { getLocale } from 'next-intl/server';
import { isHdkError } from '@/modules/hdk/api/errors';
import { saveSearchSetting } from '@/modules/hdk/api/search-settings';
import { requireStaffActor } from '@/modules/hdu/api';

// Раздел "Поиск" настроек (план W6, задача 9; ответ владельца 0070, пункт 4): синонимы, словарь узбекского и
// курирование решений. Права, свежий вход и значения проверяет модуль hdk, итог показывается кодом в адресе страницы.

export async function saveSearchSettingAction(form: FormData): Promise<void> {
  const staff = await requireStaffActor({ roles: ['admin'] });
  const page = `/${await getLocale()}/agent/settings/search`;
  const kind = String(form.get('kind') ?? '');
  let line: number | null = null;
  try {
    const result = await saveSearchSetting(staff, { kind, text: String(form.get('text') ?? '') });
    if (!result.ok) line = result.line;
  } catch (error) {
    if (!isHdkError(error)) throw error;
    redirect(`${page}?error=${error.code}`);
  }
  redirect(line === null ? `${page}?done=${encodeURIComponent(kind)}` : `${page}?error=line&kind=${encodeURIComponent(kind)}&line=${line}`);
}
