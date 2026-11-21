'use server';

import { redirect } from 'next/navigation';
import { getLocale } from 'next-intl/server';
import { bulkAction, deleteFilter, isHdtError, parseNumber, saveFilter } from '@/modules/hdt/api';
import { requireStaffActor } from '@/modules/hdu/api';

// Сохранённые списки рабочего места (FR-AG-14, UX-A-09): сохранить текущую очередь, сортировку и поиск под
// названием, удалить свой.

const text = (form: FormData, name: string) => String(form.get(name) ?? '').trim();

function back(locale: string, form: FormData, extra: string): string {
  const params = new URLSearchParams();
  for (const key of ['queue', 'sort', 'q']) if (text(form, key)) params.set(key, text(form, key));
  return `/${locale}/agent/queues?${params.toString()}${params.size > 0 ? '&' : ''}${extra}`;
}

export async function saveFilterAction(form: FormData): Promise<void> {
  const staff = await requireStaffActor();
  const locale = await getLocale();
  try {
    await saveFilter(staff, {
      name: text(form, 'name'),
      query: { queue: text(form, 'queue') || 'new', sort: text(form, 'sort') || undefined, q: text(form, 'q') || undefined },
      isShared: form.get('isShared') === 'on',
    });
  } catch (error) {
    if (!isHdtError(error)) throw error;
    redirect(back(locale, form, 'error=filter_invalid'));
  }
  redirect(back(locale, form, 'done=filter_saved'));
}

export async function deleteFilterAction(form: FormData): Promise<void> {
  const staff = await requireStaffActor();
  const locale = await getLocale();
  try {
    await deleteFilter(staff, text(form, 'filterId'));
  } catch (error) {
    if (!isHdtError(error)) throw error;
  }
  redirect(back(locale, form, 'done=filter_deleted'));
}

// --- Массовые действия (FR-AG-20, UX-A-10; план M3, задача 11) ---

export type BulkState = { status: 'idle' } | { status: 'done'; done: number[]; refused: { number: number; code: string }[] } | { status: 'error'; code: string };

/** Действие над выбранными обращениями: каждое своей транзакцией, итог по каждому. */
export async function bulkQueueAction(_prev: BulkState, form: FormData): Promise<BulkState> {
  const staff = await requireStaffActor();
  const numbers = form.getAll('numbers').map(Number);
  const kind = text(form, 'action');
  const input =
    kind === 'assign'
      ? { action: 'assign', numbers, assigneeId: text(form, 'assigneeId') || null }
      : kind === 'duplicate'
        ? { action: 'duplicate', numbers, intoNumber: parseNumber(text(form, 'into')) ?? 'invalid' }
        : kind === 'queue_l2'
          ? { action: 'queue', numbers, to: 'l2', reason: text(form, 'reason'), checked: text(form, 'checked'), needed: text(form, 'needed') }
          : { action: 'queue', numbers, to: 'l1', explanation: text(form, 'explanation') };
  try {
    const result = await bulkAction(staff, input);
    return { status: 'done', ...result };
  } catch (error) {
    if (!isHdtError(error)) throw error;
    return { status: 'error', code: error.code };
  }
}
