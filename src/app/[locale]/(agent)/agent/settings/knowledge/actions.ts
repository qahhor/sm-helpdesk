'use server';

import { redirect } from 'next/navigation';
import { getLocale } from 'next-intl/server';
import { isHdaError, saveAiDailyLimit } from '@/modules/hda/api/settings';
import { isHdkError } from '@/modules/hdk/api/errors';
import { saveAllowedDomains } from '@/modules/hdk/api/publish';
import { requireStaffActor } from '@/modules/hdu/api';

// Раздел "Решения" настроек (план M5, задача 4; FR-SOL-04): домены, на которые решения могут ссылаться. Права, свежий
// вход и значения проверяет модуль hdk, итог показывается кодом в адресе страницы.

export async function saveAllowedDomainsAction(form: FormData): Promise<void> {
  const staff = await requireStaffActor({ roles: ['admin'] });
  const page = `/${await getLocale()}/agent/settings/knowledge`;
  let invalid: string | null = null;
  try {
    const result = await saveAllowedDomains(staff, { text: String(form.get('domains') ?? '') });
    if (!result.ok) invalid = result.invalid;
  } catch (error) {
    if (!isHdkError(error)) throw error;
    redirect(`${page}?error=${error.code}`);
  }
  redirect(invalid === null ? `${page}?done=saved` : `${page}?error=domain&value=${encodeURIComponent(invalid)}`);
}

/** Суточный предел вызовов AI (план M5, решение 13): администратор со свежим входом, запись в журнал. */
export async function saveAiLimitAction(form: FormData): Promise<void> {
  const staff = await requireStaffActor({ roles: ['admin'] });
  const page = `/${await getLocale()}/agent/settings/knowledge`;
  try {
    await saveAiDailyLimit(staff, { limit: String(form.get('limit') ?? '') });
  } catch (error) {
    if (!isHdaError(error)) throw error;
    redirect(`${page}?error=${error.code === 'invalid_input' ? 'ai_limit' : error.code}`);
  }
  redirect(`${page}?done=ai_limit`);
}
