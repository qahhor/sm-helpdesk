'use server';

import { redirect } from 'next/navigation';
import { getLocale } from 'next-intl/server';
import { aiFeedbackByLink } from '@/modules/hdt/api/ai-link';

/** Нажатие на странице подтверждения из письма Теза: сама ссылка ничего не меняет (план M5b, задача 6). */
export async function aiAnswerAction(formData: FormData): Promise<void> {
  const locale = await getLocale();
  const token = formData.get('token');
  const result = await aiFeedbackByLink({ token: typeof token === 'string' ? token : '' });
  if (result.ok) redirect(`/${locale}/ai-answer?done=${result.choice}`);
  const back = result.code === 'rate_limited' && typeof token === 'string' ? `t=${encodeURIComponent(token)}&` : '';
  redirect(`/${locale}/ai-answer?${back}error=${result.code}`);
}
