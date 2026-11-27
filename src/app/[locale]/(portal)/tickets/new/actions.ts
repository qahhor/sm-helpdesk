'use server';

import { redirect } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { isHdkError } from '@/modules/hdk/api/errors';
import { recordSuggestNotHelped, recordSuggestTicket, suggestForClient } from '@/modules/hdk/api/suggest';
import { createTicket, isHdtError } from '@/modules/hdt/api';
import { isHdpError } from '@/modules/hdp/api';
import { type PublicProblemCard, problemForSuggest, reportAffected } from '@/modules/hdp/api/client';
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
      // Режим B виджета (план M6, задача 8): признак и подсказки телом формы, сервис проверяет их сам.
      widget: formData.get('widget') ?? undefined,
      context: formData.get('context') ?? undefined,
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

/** Ответ подсказки формы: решения и известная проблема по сигнатуре текста (план M5c, решение 13). */
export type SuggestResult = { items: SuggestItem[]; knownProblem: PublicProblemCard | null };

/**
 * "Похоже, это уже решали" и "Мы знаем об этой проблеме": подсказку и проблему действие собирает из модуля знаний и
 * модуля проблем по отдельности. При любой ошибке блок просто не показывается, форма работает.
 */
export async function suggestAction(input: { text: string; sessionId: string; moduleId: string | null }): Promise<SuggestResult> {
  const client = await requireClientActor();
  const locale = await getLocale();
  const knownProblem = await problemForSuggest(client.actor, { text: input.text, locale }).catch(() => null);
  try {
    const { items } = await suggestForClient(client, { ...input, locale });
    if (items.length === 0) return { items: [], knownProblem };
    const t = await getTranslations('client.tickets.new.suggest');
    return {
      items: items.map((item) => ({ number: item.number, slug: item.slug, title: item.title, exact: item.exact, orgLabel: item.orgCount === null ? null : t('orgCount', { count: item.orgCount }) })),
      knownProblem,
    };
  } catch (error) {
    if (isHdkError(error)) return { items: [], knownProblem };
    throw error;
  }
}

/**
 * "Меня это тоже затронуло" на форме портала (FR-KP-08, решение 14): привязанное обращение одним нажатием, описание
 * из поля формы. Второе нажатие ведёт к уже созданному обращению.
 */
export async function reportAffectedAction(formData: FormData): Promise<void> {
  const client = await requireClientActor();
  const locale = await getLocale();
  let target: string;
  try {
    const { number, created } = await reportAffected(client, { problemNumber: Number(formData.get('problemNumber')), locale, description: String(formData.get('description') ?? '') });
    target = `/${locale}/tickets/SUP-${number}${created ? '?created=1' : '?done=already_reported'}`;
  } catch (error) {
    if (!isHdpError(error) && !isHdtError(error)) throw error;
    target = `/${locale}/tickets/new?error=${error.code}`;
  }
  redirect(target);
}

export async function suggestNotHelpedAction(input: { sessionId: string }): Promise<void> {
  const client = await requireClientActor();
  try {
    await recordSuggestNotHelped(client, input);
  } catch (error) {
    if (!isHdkError(error)) throw error;
  }
}
