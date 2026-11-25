'use server';

import { isHdiError } from '@/modules/hdi/api/errors';
import { unvoteIdea, voteIdea } from '@/modules/hdi/api/votes';
import { requireClientActor } from '@/modules/hdu/api';

// Голос за идею без ухода со страницы (FR-IDEA-02, 04; план M7, задачи 3 и 5). Голосующий из актора клиента, номер идеи
// только поиск строки. Ошибка возвращается кодом: страница откатывает мгновенный отклик и показывает текст.

export type VoteResult = { voted: boolean; voteCount: number } | { error: string };

export async function voteAction(input: { number: number; vote: boolean }): Promise<VoteResult> {
  const client = await requireClientActor();
  try {
    return input.vote ? await voteIdea(client, { number: input.number }) : await unvoteIdea(client, { number: input.number });
  } catch (error) {
    if (!isHdiError(error)) throw error;
    return { error: error.code };
  }
}
