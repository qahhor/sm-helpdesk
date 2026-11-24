import type { QueueKey, QueueSort } from './core/agent-queue-keys';

// Модуль hdt: адреса страницы очередей сотрудника. У очереди "Все" сортировка по умолчанию своя (по последнему
// изменению: по сроку вперёд вышли бы давно закрытые обращения), у остальных по сроку. Поэтому "сортировки нет
// в адресе" значит разное для разных очередей, и ссылка считает умолчание для той очереди, куда ведёт
// (итоговая проверка волны 1, замечание F2).

/** Где сотрудник сейчас. sortChosen: сортировка задана в адресе им самим, а не взята по умолчанию. */
export type QueueLocation = { queue: QueueKey; sort: QueueSort; sortChosen: boolean; q?: string; tag?: string };
/** after: ключ листания (сортировка по последнему изменению); с ним номер страницы в адрес не пишется. */
export type QueueTarget = { queue?: QueueKey; sort?: QueueSort; q?: string; tag?: string; page?: number; after?: string };

export const defaultQueueSort = (queue: QueueKey): QueueSort => (queue === 'all' ? 'updated' : 'sla');

/**
 * Адрес страницы очередей. Сортировка: заданная ссылкой; иначе в той же очереди текущая, а при переходе в другую
 * очередь текущая только если сотрудник выбрал её сам. Сортировка по умолчанию целевой очереди в адрес не пишется.
 */
export function queueHref(current: QueueLocation, next: QueueTarget): string {
  const queue = next.queue ?? current.queue;
  const keepsSort = queue === current.queue || current.sortChosen;
  const sort = next.sort ?? (keepsSort ? current.sort : defaultQueueSort(queue));
  const search = new URLSearchParams();
  search.set('queue', queue);
  if (sort !== defaultQueueSort(queue)) search.set('sort', sort);
  const query = 'q' in next ? next.q : current.q;
  if (query) search.set('q', query);
  // Фильтр по тегу живёт в той же очереди: переход в другую очередь его снимает, если ссылка не задала свой.
  const tag = 'tag' in next ? next.tag : queue === current.queue ? current.tag : undefined;
  if (tag) search.set('tag', tag);
  if (next.after) search.set('after', next.after);
  else if (next.page && next.page > 1) search.set('page', String(next.page));
  return `/agent/queues?${search.toString()}`;
}
