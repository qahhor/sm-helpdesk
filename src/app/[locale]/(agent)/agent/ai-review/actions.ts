'use server';

import { redirect } from 'next/navigation';
import { getLocale } from 'next-intl/server';
import { isHdaError, reviewAiAnswer } from '@/modules/hda/api/review';
import { requireStaffActor } from '@/modules/hdu/api';

// Итог разбора ответа помощника (план M5b, задача 8; FR-AI-16). Права и значение проверяет модуль hda.

export async function reviewAiAnswerAction(form: FormData): Promise<void> {
  const staff = await requireStaffActor();
  const page = `/${await getLocale()}/agent/ai-review`;
  try {
    await reviewAiAnswer(staff, { runId: String(form.get('runId') ?? ''), result: String(form.get('result') ?? '') });
  } catch (error) {
    if (!isHdaError(error)) throw error;
    redirect(`${page}?error=${error.code === 'forbidden' ? 'forbidden' : 'invalid_input'}`);
  }
  redirect(`${page}?done=1`);
}
