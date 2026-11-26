'use server';

import { redirect } from 'next/navigation';
import { getLocale } from 'next-intl/server';
import { parseIdeaNumber } from '@/modules/hdi/api/constants';
import { isHdiError } from '@/modules/hdi/api/errors';
import { addStaffReply, moderateComment } from '@/modules/hdi/api/comments';
import { declineIdea, editIdeaAsModerator, mergeIdea, publishIdea, reviewIdeaTranslation } from '@/modules/hdi/api/moderate';
import { decideCycle, draftCycleExplanation } from '@/modules/hdi/api/cycles';
import { releaseIdea, sendIdeaToDevelopment } from '@/modules/hdi/api/development';
import { requireStaffActor } from '@/modules/hdu/api';

// Действия карточки идеи и отбора месяца на рабочем месте (план M7, задачи 4, 6 и 9). Права (product, admin), данные и переходы проверяет
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

/** "Передать в разработку" выбранную идею (решение 18): поля задачи ручного режима или номер задачи режима API. */
export async function sendIdeaToDevelopmentAction(formData: FormData): Promise<void> {
  const staff = await requireStaffActor();
  const field = (name: string) => {
    const value = formData.get(name);
    return typeof value === 'string' && value.trim() !== '' ? { [name]: value } : {};
  };
  await run(formData, (number) => sendIdeaToDevelopment(staff, { number, ...field('externalId'), ...field('url'), ...field('title') }), 'in_development');
}

/** "Выпущена" с версией и датой (решение 18). */
export async function releaseIdeaAction(formData: FormData): Promise<void> {
  const staff = await requireStaffActor();
  await run(formData, (number) => releaseIdea(staff, { number, version: String(formData.get('version') ?? ''), releasedOn: String(formData.get('releasedOn') ?? '') }), 'released');
}

/** Выбор идеи месяца с объяснением (решение 17). Итог отметкой в адресе страницы отбора. */
export async function decideCycleAction(formData: FormData): Promise<void> {
  const staff = await requireStaffActor();
  const locale = await getLocale();
  const text = (name: string) => String(formData.get(name) ?? '');
  let status = 'decided';
  try {
    await decideCycle(staff, {
      cycle: text('cycle'),
      number: text('number'),
      explanationRu: text('explanationRu'),
      explanationUz: text('explanationUz'),
      explanationEn: text('explanationEn'),
      // Отметки машинного черновика ставит форма (пункт M6 итоговой проверки M7).
      explanationUzMachine: text('explanationUzMachine') === '1',
      explanationEnMachine: text('explanationEnMachine') === '1',
    });
  } catch (error) {
    if (!isHdiError(error)) throw error;
    status = `error-${error.code}`;
  }
  redirect(`/${locale}/agent/ideas/cycles?status=${status}`);
}

export type DraftState = { uz: string; en: string } | { error: string };

/** Машинный черновик объяснения на узбекском и английском (решение 17): только показывается в форме, не сохраняется. */
export async function draftExplanationAction(text: string): Promise<DraftState> {
  const staff = await requireStaffActor();
  try {
    const draft = await draftCycleExplanation(staff, { text });
    if (draft.uz === null && draft.en === null) return { error: 'unavailable' };
    return { uz: draft.uz ?? '', en: draft.en ?? '' };
  } catch (error) {
    if (!isHdiError(error)) throw error;
    return { error: error.code };
  }
}
