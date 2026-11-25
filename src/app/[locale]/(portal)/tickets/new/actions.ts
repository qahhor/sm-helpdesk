'use server';

import { redirect } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { isHdkError } from '@/modules/hdk/api/errors';
import { recordSuggestNotHelped, recordSuggestTicket, suggestForClient } from '@/modules/hdk/api/suggest';
import { createTicket, isHdtError } from '@/modules/hdt/api';
import { requireClientActor } from '@/modules/hdu/api';

// Отправка нового обращения (FR-TK-01, FR-TK-02). Организация и автор берутся из актора клиента, а не из формы.
// Подсказка решений (план M5, задача 10): запрос, "Не помогло" и исход "обращение создано" для сессии формы.

export type NewTicketState = { error: string | null; field: 'description' | null };

export async function createTicketAction(_state: NewTicketState, formData: FormData): Promise<NewTicketState> {
  const client = await requireClientActor();
  const locale = await getLocale();
  const description = String(formData.get('description') ?? '');
  // Ошибка рядом с полем простыми словами (UX-C-10): пустое описание отдельно от остальных.
  if (description.trim() === '') return { error: 'description', field: 'description' };
  let number: number;
  let ticketId: string;
  try {
    ({ number, ticketId } = await createTicket(client, {
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
  // Подсказка показывалась в этой сессии формы: исход "обращение создано" (решение 12). Сбой записи обращение не отменяет.
  await recordSuggestTicket(client, { sessionId: formData.get('suggestSession'), ticketId }).catch(() => undefined);
  // Отметка created: страница обращения удалит черновик формы (до успеха он не трогается).
  redirect(`/${locale}/tickets/SUP-${number}?created=1`);
}

/** Решение в блоке подсказки: адрес, заголовок, пометка точного совпадения, число организаций готовой строкой. */
export type SuggestItem = { number: number; slug: string; title: string; exact: boolean; orgLabel: string | null };

/** "Похоже, это уже решали": при любой ошибке блок просто не показывается, форма работает. */
export async function suggestAction(input: { text: string; sessionId: string; moduleId: string | null }): Promise<SuggestItem[]> {
  const client = await requireClientActor();
  const locale = await getLocale();
  try {
    const { items } = await suggestForClient(client, { ...input, locale });
    if (items.length === 0) return [];
    const t = await getTranslations('client.tickets.new.suggest');
    return items.map((item) => ({ number: item.number, slug: item.slug, title: item.title, exact: item.exact, orgLabel: item.orgCount === null ? null : t('orgCount', { count: item.orgCount }) }));
  } catch (error) {
    if (isHdkError(error)) return [];
    throw error;
  }
}

export async function suggestNotHelpedAction(input: { sessionId: string }): Promise<void> {
  const client = await requireClientActor();
  try {
    await recordSuggestNotHelped(client, input);
  } catch (error) {
    if (!isHdkError(error)) throw error;
  }
}
