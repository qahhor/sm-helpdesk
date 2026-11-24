'use server';

import { redirect } from 'next/navigation';
import { getLocale } from 'next-intl/server';
import { isHdtError, saveCsatReview } from '@/modules/hdt/api';
import { requireStaffActor } from '@/modules/hdu/api';

// Заметка о разборе низкой оценки (FR-MET-07). Права и данные проверяет модуль hdt (Customer Care и администратор),
// итог показывается кодом в адресе страницы. Период страницы возвращается из скрытого поля формы: это только
// параметры показа, страница разбирает их заново.

const SAFE_QUERY = /^[a-zA-Z0-9=&_-]{0,200}$/;

export async function saveCsatReviewAction(form: FormData): Promise<void> {
  const staff = await requireStaffActor();
  const back = String(form.get('back') ?? '');
  const query = SAFE_QUERY.test(back) ? back : '';
  const page = `/${await getLocale()}/agent/metrics`;
  const withQuery = (result: string) => `${page}?${query ? `${query}&` : ''}${result}#low-ratings`;
  try {
    await saveCsatReview(staff, { number: form.get('number'), note: String(form.get('note') ?? '') });
  } catch (error) {
    if (!isHdtError(error)) throw error;
    redirect(withQuery(`error=${error.code}`));
  }
  redirect(withQuery('done=reviewed'));
}
