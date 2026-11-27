'use server';

import { refresh } from 'next/cache';
import { redirect } from 'next/navigation';
import { getLocale } from 'next-intl/server';
import {
  confirmResolution,
  isHdtError,
  parseNumber,
  rateTicket,
  reopenTicket,
  replyToTicket,
  setTicketVisibility,
  unwatchTicket,
  watchTicket,
} from '@/modules/hdt/api';
import { aiFeedback } from '@/modules/hdt/api/ai-feedback';
import { isHduError, requireClientActor, switchOrganizationOfRequest } from '@/modules/hdu/api';

// Действия на странице обращения (FR-TK-08 - FR-TK-12). Номер из формы проверяет модуль обращений:
// невидимое клиенту обращение для него не существует. Организация и автор берутся из актора.

const numberOf = (formData: FormData): number | null => parseNumber(String(formData.get('number') ?? ''));

/** Выполняет действие и возвращает на страницу обращения с отметкой результата или кодом ошибки. */
async function run(formData: FormData, action: (number: number) => Promise<void>, done: string): Promise<never> {
  const locale = await getLocale();
  const number = numberOf(formData);
  if (number === null) redirect(`/${locale}/tickets`);
  const page = `/${locale}/tickets/SUP-${number}`;
  try {
    await action(number);
  } catch (error) {
    if (!isHdtError(error)) throw error;
    if (error.code === 'not_found') redirect(`/${locale}/tickets`);
    redirect(`${page}?error=${error.code}`);
  }
  redirect(`${page}?done=${done}`);
}

export type ReplyState = { error: string | null };

/** Ответ клиента с файлами. Состояние формы возвращается при ошибке: текст остаётся в поле (UX-C-10). */
export async function replyAction(_state: ReplyState, formData: FormData): Promise<ReplyState> {
  const client = await requireClientActor();
  const locale = await getLocale();
  const number = numberOf(formData);
  if (number === null) redirect(`/${locale}/tickets`);
  if (String(formData.get('body') ?? '').trim() === '') return { error: 'invalid_input' };
  try {
    await replyToTicket(client, { number, body: formData.get('body'), attachmentIds: formData.getAll('attachmentIds') });
  } catch (error) {
    if (!isHdtError(error)) throw error;
    return { error: error.code };
  }
  redirect(`/${locale}/tickets/SUP-${number}?done=replied`);
}

export async function confirmAction(formData: FormData): Promise<void> {
  const client = await requireClientActor();
  await run(formData, (number) => confirmResolution(client, number), 'confirmed');
}

export async function reopenAction(formData: FormData): Promise<void> {
  const client = await requireClientActor();
  await run(formData, (number) => reopenTicket(client, { number }), 'reopened');
}

export async function rateAction(formData: FormData): Promise<void> {
  const client = await requireClientActor();
  // При оценке 1-3 причина обязательна (FR-TK-11): своя понятная ошибка вместо общей.
  if (Number(formData.get('score')) <= 3 && !formData.get('reason')) {
    const number = numberOf(formData);
    redirect(`/${await getLocale()}/tickets${number === null ? '' : `/SUP-${number}?error=reason`}`);
  }
  await run(
    formData,
    (number) => rateTicket(client, { number, score: formData.get('score'), reason: formData.get('reason'), comment: formData.get('comment') }),
    'rated',
  );
}

export async function visibilityAction(formData: FormData): Promise<void> {
  const client = await requireClientActor();
  await run(formData, (number) => setTicketVisibility(client, { number, visibility: formData.get('visibility') }), 'visibility');
}

export async function watchAction(formData: FormData): Promise<void> {
  const client = await requireClientActor();
  const watch = formData.get('watch') === '1';
  await run(formData, (number) => (watch ? watchTicket(client, number) : unwatchTicket(client, number)), watch ? 'watched' : 'unwatched');
}

/**
 * Переход в другую свою организацию, чтобы открыть её обращение (UX-C-06). Организацию проверяет модуль
 * идентичности: принимается только действующее членство. После переключения открывается то же обращение.
 */
export async function switchToTicketAction(formData: FormData): Promise<void> {
  await requireClientActor();
  const locale = await getLocale();
  const number = numberOf(formData);
  try {
    await switchOrganizationOfRequest(formData.get('orgId'));
  } catch (error) {
    if (!isHduError(error)) throw error;
    redirect(`/${locale}/tickets`);
  }
  // Название организации живёт в шапке раскладки: её нужно перерисовать.
  refresh();
  redirect(number === null ? `/${locale}/tickets` : `/${locale}/tickets/SUP-${number}`);
}

/**
 * Кнопки под сообщением Теза (план M5b, задача 5; FR-AI-08, FR-TK-18): "Помогло", "Не помогло", "Нужен сотрудник",
 * выбор решения в вопросе. Право на обращение, сообщение и переход проверяет модуль обращений.
 */
export async function aiFeedbackAction(formData: FormData): Promise<void> {
  const client = await requireClientActor();
  const locale = await getLocale();
  const number = numberOf(formData);
  if (number === null) redirect(`/${locale}/tickets`);
  const page = `/${locale}/tickets/SUP-${number}`;
  let done: string;
  try {
    done = await aiFeedback(client, {
      number,
      messageId: String(formData.get('messageId') ?? ''),
      choice: String(formData.get('choice') ?? ''),
      ...(formData.get('articleId') ? { articleId: String(formData.get('articleId')) } : {}),
    });
  } catch (error) {
    if (!isHdtError(error)) throw error;
    if (error.code === 'not_found') redirect(`/${locale}/tickets`);
    redirect(`${page}?error=ai_feedback`);
  }
  redirect(`${page}?done=ai_${done}`);
}
