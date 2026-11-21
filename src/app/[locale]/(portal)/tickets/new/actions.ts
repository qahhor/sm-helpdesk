'use server';

import { redirect } from 'next/navigation';
import { getLocale } from 'next-intl/server';
import { createTicket, isHdtError } from '@/modules/hdt/api';
import { requireClientActor } from '@/modules/hdu/api';

// Отправка нового обращения (FR-TK-01, FR-TK-02). Организация и автор берутся из актора клиента, а не из формы.

export type NewTicketState = { error: string | null; field: 'description' | null };

export async function createTicketAction(_state: NewTicketState, formData: FormData): Promise<NewTicketState> {
  const client = await requireClientActor();
  const locale = await getLocale();
  const description = String(formData.get('description') ?? '');
  // Ошибка рядом с полем простыми словами (UX-C-10): пустое описание отдельно от остальных.
  if (description.trim() === '') return { error: 'description', field: 'description' };
  let number: number;
  try {
    ({ number } = await createTicket(client, {
      description,
      title: formData.get('title'),
      type: formData.get('type'),
      impact: formData.get('impact'),
      visibility: formData.get('visibility') ?? undefined,
      moduleId: formData.get('moduleId'),
      relatedNumber: formData.get('relatedNumber'),
      attachmentIds: formData.getAll('attachmentIds'),
      locale,
    }));
  } catch (error) {
    if (!isHdtError(error)) throw error;
    return { error: error.code, field: null };
  }
  // Отметка created: страница обращения удалит черновик формы (до успеха он не трогается).
  redirect(`/${locale}/tickets/SUP-${number}?created=1`);
}
