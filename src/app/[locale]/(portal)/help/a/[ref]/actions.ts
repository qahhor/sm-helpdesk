'use server';

import { recordSolutionFeedback } from '@/modules/hdk/api/client';
import { isHdkError } from '@/modules/hdk/api/errors';
import { requireClientActor } from '@/modules/hdu/api';

// "Помогло" и "Не помогло" на странице решения (план M5, задача 4, решение 12). Сессия, номер и исход проверяет
// модуль hdk; счётчик решения и исход сессии подсказки пишет система, клиент таблиц исходов не читает.

export async function solutionFeedbackAction(input: { number: number; outcome: 'helped' | 'not_helped'; sessionId?: string }): Promise<{ ok: boolean }> {
  const client = await requireClientActor();
  try {
    await recordSolutionFeedback(client, input);
    return { ok: true };
  } catch (error) {
    if (!isHdkError(error)) throw error;
    return { ok: false };
  }
}
