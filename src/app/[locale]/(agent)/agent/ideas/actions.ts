'use server';

import { redirect } from 'next/navigation';
import { getLocale } from 'next-intl/server';
import { parseIdeaNumber } from '@/modules/hdi/api/constants';
import { isHdiError } from '@/modules/hdi/api/errors';
import { addStaffReply, moderateComment } from '@/modules/hdi/api/comments';
import { declineIdea, editIdeaAsModerator, mergeIdea, publishIdea, reviewIdeaTranslation } from '@/modules/hdi/api/moderate';
import { requireStaffActor } from '@/modules/hdu/api';

// Действия карточки идеи на рабочем месте (план M7, задачи 4 и 6). Права (product, admin), данные и переходы проверяет
// модуль hdi и ещё раз база; страница получает итог отметкой в адресе. Формы обычные: работают без скриптов.

async function run(formData: FormData, action: (number: number) => Promise<unknown>, done: string): Promise<never> {
  const locale = await getLocale();
  const number = parseIdeaNumber(String(formData.get('number') ?? ''));
  if (!number) redirect(`/${locale}/agent/ideas`);
  let status = done;
  try {
    await action(number);
  } catch (error) {
    if (!isHdiError(error)) throw error;
    status = `error-${error.code}`;
  }
  redirect(`/${locale}/agent/ideas/${number}?status=${status}`);
}

export async function publishIdeaAction(formData: FormData): Promise<void> {
  const staff = await requireStaffActor();
  await run(formData, (number) => publishIdea(staff, { number, findingsChecked: formData.get('findingsChecked') === 'on' }), 'published');
}

export async function declineIdeaAction(formData: FormData): Promise<void> {
  const staff = await requireStaffActor();
  await run(formData, (number) => declineIdea(staff, { number, reason: String(formData.get('reason') ?? '') }), 'declined');
}

export async function mergeIdeaAction(formData: FormData): Promise<void> {
  const staff = await requireStaffActor();
  await run(formData, (number) => mergeIdea(staff, { number, into: String(formData.get('into') ?? '').trim() }), 'merged');
}

export async function editIdeaAction(formData: FormData): Promise<void> {
  const staff = await requireStaffActor();
  await run(
    formData,
    (number) => editIdeaAsModerator(staff, { number, title: String(formData.get('title') ?? ''), body: String(formData.get('body') ?? ''), moduleId: String(formData.get('moduleId') ?? '') }),
    'edited',
  );
}

export async function reviewTranslationAction(formData: FormData): Promise<void> {
  const staff = await requireStaffActor();
  await run(
    formData,
    (number) => reviewIdeaTranslation(staff, { number, locale: String(formData.get('locale') ?? ''), title: String(formData.get('title') ?? ''), body: String(formData.get('body') ?? '') }),
    'translation',
  );
}

/** Ответ Smartup со значком (FR-IDEA-07): любой сотрудник. */
export async function staffReplyAction(formData: FormData): Promise<void> {
  const staff = await requireStaffActor();
  await run(formData, (number) => addStaffReply(staff, { number, body: String(formData.get('body') ?? '') }), 'replied');
}

/** Публикация удержанного комментария или скрытие с причиной: только product и admin (решение 8). */
export async function moderateCommentAction(formData: FormData): Promise<void> {
  const staff = await requireStaffActor();
  const action = formData.get('action') === 'publish' ? 'publish' : 'hide';
  const commentId = String(formData.get('commentId') ?? '');
  await run(
    formData,
    () => moderateComment(staff, action === 'publish' ? { commentId, action } : { commentId, action, reason: String(formData.get('reason') ?? '') }),
    action === 'publish' ? 'comment_published' : 'comment_hidden',
  );
}
