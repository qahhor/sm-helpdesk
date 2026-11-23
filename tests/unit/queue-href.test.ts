import { expect, test } from 'vitest';
import { defaultQueueSort, queueHref } from '@/modules/hdt/queue-href';

// Ссылки страницы очередей (итоговая проверка волны 1, замечание F2). У очереди "Все" своя сортировка по умолчанию
// (по последнему изменению), у остальных по сроку: ссылка не должна терять выбранную сортировку и не должна
// переносить чужую сортировку по умолчанию в рабочую очередь.

test('сортировка по умолчанию: "Все" по последнему изменению, остальные по сроку', () => {
  expect(defaultQueueSort('all')).toBe('updated');
  expect(defaultQueueSort('new')).toBe('sla');
  expect(defaultQueueSort('mine')).toBe('sla');
});

test('следующая страница "Все" с выбранной сортировкой по сроку сохраняет её', () => {
  const current = { queue: 'all', sort: 'sla', sortChosen: true } as const;
  expect(queueHref(current, { page: 2 })).toBe('/agent/queues?queue=all&sort=sla&page=2');
  expect(queueHref(current, {})).toBe('/agent/queues?queue=all&sort=sla');
});

test('сортировка по умолчанию в адрес не пишется', () => {
  expect(queueHref({ queue: 'all', sort: 'updated', sortChosen: false }, { page: 3 })).toBe('/agent/queues?queue=all&page=3');
  expect(queueHref({ queue: 'new', sort: 'sla', sortChosen: false }, { page: 2 })).toBe('/agent/queues?queue=new&page=2');
});

test('переход из "Все" в рабочую очередь не переносит сортировку по умолчанию', () => {
  const fromAll = { queue: 'all', sort: 'updated', sortChosen: false, q: 'счёт' } as const;
  expect(queueHref(fromAll, { queue: 'new', q: undefined, page: 1 })).toBe('/agent/queues?queue=new');
  // И обратно: из "Новых" по сроку в "Все" по её умолчанию.
  expect(queueHref({ queue: 'new', sort: 'sla', sortChosen: false }, { queue: 'all', q: undefined, page: 1 })).toBe('/agent/queues?queue=all');
});

test('сортировка, выбранная сотрудником, переносится в другую очередь', () => {
  const chosen = { queue: 'new', sort: 'client_waiting', sortChosen: true } as const;
  expect(queueHref(chosen, { queue: 'l2', q: undefined, page: 1 })).toBe('/agent/queues?queue=l2&sort=client_waiting');
  expect(queueHref({ queue: 'new', sort: 'sla', sortChosen: true }, { queue: 'all', q: undefined, page: 1 })).toBe('/agent/queues?queue=all&sort=sla');
});

test('сохранённый фильтр открывается со своей сортировкой, поиск сохраняется при листании', () => {
  const current = { queue: 'new', sort: 'sla', sortChosen: false } as const;
  expect(queueHref(current, { queue: 'all', sort: 'sla', q: 'ИНН 123', page: 1 })).toBe('/agent/queues?queue=all&sort=sla&q=%D0%98%D0%9D%D0%9D+123');
  expect(queueHref({ ...current, q: 'склад' }, { page: 2 })).toBe('/agent/queues?queue=new&q=%D1%81%D0%BA%D0%BB%D0%B0%D0%B4&page=2');
});
