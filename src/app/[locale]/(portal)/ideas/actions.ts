'use server';

import { redirect } from 'next/navigation';
import { getLocale } from 'next-intl/server';
import { followIdea } from '@/modules/hdi/api/board';
import { parseIdeaNumber } from '@/modules/hdi/api/constants';
import { isHdiError } from '@/modules/hdi/api/errors';
import { editOwnIdea, setIdeaShowOrg } from '@/modules/hdi/api/submit';
import { unvoteIdea, voteIdea } from '@/modules/hdi/api/votes';
import { requireClientActor } from '@/modules/hdu/api';

// Голос за идею без ухода со страницы (FR-IDEA-02, 04; план M7, задачи 3 и 5). Голосующий из актора клиента, номер идеи
// только поиск строки. Ошибка возвращается кодом: страница откатывает мгновенный отклик и показывает текст.
// Подписка, показ организации и правка своей идеи на модерации: обычные формы с переходом обратно на страницу идеи и
// отметкой результата в адресе (работают без скриптов).

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

async function ideaForm(formData: FormData, run: (number: number) => Promise<unknown>, done: string, hash = ''): Promise<never> {
  const locale = await getLocale();
  const number = parseIdeaNumber(String(formData.get('number') ?? ''));
  if (!number) redirect(`/${locale}/ideas`);
  let status = done;
  try {
    const result = await run(number);
    if (typeof result === 'string') status = result;
  } catch (error) {
    if (!isHdiError(error)) throw error;
    status = `error-${error.code}`;
  }
  redirect(`/${locale}/ideas/${number}?status=${status}${hash}`);
}

/** "Следить" и "Не следить" (FR-IDEA-11). */
export async function followAction(formData: FormData): Promise<void> {
  const client = await requireClientActor();
  const follow = formData.get('follow') === '1';
  await ideaForm(formData, (number) => followIdea(client, { number, follow }), follow ? 'followed' : 'unfollowed');
}

/** "Показывать мою организацию" у своей идеи в любой момент (FR-IDEA-06, решение 7). */
export async function showOrgAction(formData: FormData): Promise<void> {
  const client = await requireClientActor();
  await ideaForm(formData, (number) => setIdeaShowOrg(client, { number, showOrg: formData.get('showOrg') === 'on' }), 'saved');
}

/** Правка своей идеи, пока она на модерации (решение 5). */
export async function editIdeaAction(formData: FormData): Promise<void> {
  const client = await requireClientActor();
  const locale = await getLocale();
  const number = parseIdeaNumber(String(formData.get('number') ?? ''));
  if (!number) redirect(`/${locale}/ideas`);
  try {
    await editOwnIdea(client, {
      number,
      title: String(formData.get('title') ?? ''),
      body: String(formData.get('body') ?? ''),
      moduleId: String(formData.get('moduleId') ?? ''),
      showOrg: formData.get('showOrg') === 'on',
    });
  } catch (error) {
    if (!isHdiError(error)) throw error;
    redirect(`/${locale}/ideas/${number}/edit?status=error-${error.code}`);
  }
  redirect(`/${locale}/ideas/${number}?status=edited`);
}
