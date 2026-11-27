'use server';

import { randomBytes } from 'node:crypto';
import { redirect } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { isLocale } from '@/i18n/locales';
import { candidateCard, candidateToDraft, mergeCandidate, rejectCandidate } from '@/modules/hda/api/candidate-actions';
import { isHdaError } from '@/modules/hda/api/settings';
import { requireStaffActor } from '@/modules/hdu/api';

// Действия карточки кандидата (план M5c, задача 10, решение 29). Права, данные и журнал аудита проверяет модуль hda;
// страница получает итог кодом в адресе. Формы обычные: работают без скриптов.

const text = (form: FormData, name: string) => String(form.get(name) ?? '');
const newBlockId = () => randomBytes(12).toString('base64url');

async function run(id: string, action: () => Promise<string | void>, done: string): Promise<never> {
  const locale = await getLocale();
  let target = `/${locale}/agent/candidates/${id}?done=${done}`;
  try {
    const next = await action();
    if (next) target = next;
  } catch (error) {
    if (!isHdaError(error)) throw error;
    target = `/${locale}/agent/candidates/${id}?error=${error.code}`;
  }
  redirect(target);
}

/** "Сделать черновиком решения": новое решение с текстом кандидата открывается в редакторе. */
export async function candidateToDraftAction(form: FormData): Promise<void> {
  const staff = await requireStaffActor();
  const id = text(form, 'id');
  const page = await getLocale();
  await run(
    id,
    async () => {
      const card = await candidateCard(staff, { id });
      const locale = card && isLocale(card.locale) ? card.locale : page;
      const t = await getTranslations({ locale, namespace: 'agent.solutions.template' });
      const { articleNumber } = await candidateToDraft(staff, { id }, { what: t('what'), why: t('why'), do: t('do') }, newBlockId);
      return `/${page}/agent/solutions/${articleNumber}`;
    },
    'accepted',
  );
}

export async function mergeCandidateAction(form: FormData): Promise<void> {
  const staff = await requireStaffActor();
  const id = text(form, 'id');
  await run(id, () => mergeCandidate(staff, { id, articleNumber: Number(text(form, 'articleNumber')) }), 'merged');
}

export async function rejectCandidateAction(form: FormData): Promise<void> {
  const staff = await requireStaffActor();
  const id = text(form, 'id');
  await run(id, () => rejectCandidate(staff, { id, reason: text(form, 'reason'), ...(text(form, 'comment') ? { comment: text(form, 'comment') } : {}) }), 'rejected');
}
