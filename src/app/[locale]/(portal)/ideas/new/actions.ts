'use server';

import { redirect } from 'next/navigation';
import { getLocale } from 'next-intl/server';
import { isHdiError } from '@/modules/hdi/api/errors';
import { submitIdea } from '@/modules/hdi/api/submit';
import { requireClientActor } from '@/modules/hdu/api';

// Подача идеи (FR-IDEA-01, план M7, задача 2). Автор и организация из актора клиента, а не из формы. Находки проверки
// текста возвращаются предупреждением: клиент отправляет форму ещё раз с отметкой confirm (решение 9).

export type NewIdeaState = { error: string | null; findings: string[] | null };

export async function submitIdeaAction(_state: NewIdeaState, formData: FormData): Promise<NewIdeaState> {
  const client = await requireClientActor();
  const locale = await getLocale();
  let number: number;
  try {
    const result = await submitIdea(client, {
      title: String(formData.get('title') ?? ''),
      body: String(formData.get('body') ?? ''),
      moduleId: String(formData.get('moduleId') ?? ''),
      showOrg: formData.get('showOrg') === 'on',
      locale,
      attachmentIds: formData.getAll('attachmentIds').map(String),
      confirmFindings: formData.get('confirm') === '1',
    });
    if (result.status === 'confirm') return { error: null, findings: result.findings };
    number = result.number;
  } catch (error) {
    if (!isHdiError(error)) throw error;
    return { error: error.code, findings: null };
  }
  // Отметка sent: страница покажет "Идея отправлена на проверку" и удалит черновик формы, если ушёл именно он.
  redirect(`/${locale}/ideas/new?sent=${number}`);
}
