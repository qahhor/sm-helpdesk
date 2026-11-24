import { expect, test } from 'vitest';
import { devTaskUrlOrNull } from '@/modules/hdw/dev-task-url';
import { createManualTracker } from '@/modules/hdw/dev-tracker/manual';
import { createMemoryDevTracker } from '@/modules/hdw/dev-tracker/memory';

// Таск-менеджер разработки (ТЗ 11.11, FR-DEV-01, 02; план M8, задача 7): ручная реализация никуда не обращается,
// заглушка в памяти ведёт себя как таск-менеджер. Адрес задачи показывается ссылкой: только https.

test('ручная реализация: задачу портал не создаёт и ничего о ней не знает', async () => {
  const tracker = createManualTracker();
  await expect(tracker.createTask({ title: 'Задача', descriptionMd: 'Текст', kind: 'bug', sourceUrl: 'https://hub.example.test/ru/agent/tickets/SUP-1' })).rejects.toThrow(/ручном режиме/);
  expect(await tracker.getTask('DEV-501')).toBeNull();
});

test('заглушка в памяти: создаёт задачу, отдаёт по номеру без учёта регистра, падает по команде', async () => {
  const tracker = createMemoryDevTracker();
  const input = { title: 'Задача', descriptionMd: 'Текст', kind: 'feature' as const, priority: 'p2', moduleCode: 'wms', sourceUrl: 'https://hub.example.test/ru/agent/tickets/SUP-1' };
  const created = await tracker.createTask(input);
  expect(created).toEqual({ ref: 'TASK-1', url: 'https://tracker.smartup.example/tasks/TASK-1' });
  expect(tracker.created).toEqual([input]);
  expect(await tracker.getTask('task-1')).toEqual({ ref: 'TASK-1', url: created.url, status: 'todo' });
  tracker.set({ ref: 'TASK-1', url: created.url, status: 'done', version: '5.14.2' });
  expect(await tracker.getTask('TASK-1')).toMatchObject({ status: 'done', version: '5.14.2' });
  expect(await tracker.getTask('TASK-404')).toBeNull();
  tracker.failing = true;
  await expect(tracker.getTask('TASK-1')).rejects.toThrow();
  await expect(tracker.createTask(input)).rejects.toThrow();
});

test('адрес задачи: https принимается, иные схемы, учётная запись и длинный адрес нет', () => {
  expect(devTaskUrlOrNull('https://tracker.smartup.example/tasks/DEV-501?tab=1#c', false)).toBe('https://tracker.smartup.example/tasks/DEV-501?tab=1#c');
  // Узел во внутренней сети годится: портал по адресу не ходит.
  expect(devTaskUrlOrNull('https://tracker.internal/tasks/1', false)).toBe('https://tracker.internal/tasks/1');
  for (const bad of [
    'http://tracker.smartup.example/tasks/1',
    'javascript:alert(1)',
    ' javascript:alert(1)',
    'JaVaScRiPt:alert(1)',
    'java\tscript:alert(1)',
    'data:text/html,<b>x</b>',
    'vbscript:msgbox(1)',
    'file:///etc/passwd',
    'ftp://tracker.smartup.example/1',
    '//tracker.smartup.example/1',
    'tracker.smartup.example/1',
    'https://user:pass@tracker.smartup.example/1',
    'https://user@tracker.smartup.example/1',
    `https://tracker.smartup.example/${'a'.repeat(480)}`,
    '',
  ])
    expect(devTaskUrlOrNull(bad, false), bad).toBeNull();
});

test('адрес задачи: http только для localhost и только когда сам портал работает на localhost', () => {
  expect(devTaskUrlOrNull('http://localhost:3194/tasks/1', true)).toBe('http://localhost:3194/tasks/1');
  expect(devTaskUrlOrNull('http://127.0.0.1:3194/tasks/1', true)).toBe('http://127.0.0.1:3194/tasks/1');
  expect(devTaskUrlOrNull('http://localhost:3194/tasks/1', false)).toBeNull();
  expect(devTaskUrlOrNull('http://tracker.smartup.example/tasks/1', true)).toBeNull();
  expect(devTaskUrlOrNull('http://localhost.evil.example/tasks/1', true)).toBeNull();
});
