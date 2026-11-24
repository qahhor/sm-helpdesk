'use server';

import { redirect } from 'next/navigation';
import { getLocale } from 'next-intl/server';
import { headers } from 'next/headers';
import { clientIp } from '@/modules/hdc/api';
import { rateByLink } from '@/modules/hdt/api';

/** Нажатие "Поставить оценку": сама ссылка из письма ничего не меняет (FR-TK-11, решение 0040). */
export async function rateByLinkAction(formData: FormData): Promise<void> {
  const locale = await getLocale();
  const token = formData.get('token');
  const score = formData.get('score');
  const result = await rateByLink({ token, score, reason: formData.get('reason'), comment: formData.get('comment') }, { ip: clientIp(await headers()) });
  if (result.ok) redirect(`/${locale}/rate?done=1`);
  // Ссылка остаётся на странице, пока ошибку можно исправить: причина не выбрана или запросов слишком много.
  const retry = result.code === 'reason_required' || result.code === 'rate_limited';
  const back = retry && typeof token === 'string' && typeof score === 'string' ? `t=${encodeURIComponent(token)}&score=${encodeURIComponent(score)}&` : '';
  redirect(`/${locale}/rate?${back}error=${result.code}`);
}
