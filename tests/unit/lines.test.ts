import { expect, test } from 'vitest';
import { playbookItems } from '@/modules/hdr/util';
import { pickupMinutes } from '@/modules/hdt/util';

// Передача на вторую линию (FR-LINE-06, FR-LINE-10; план M3, задача 9): пункты памятки и срок "взять в работу".

test('пункты памятки: строки без маркеров списка и флажков, пустые пропущены', () => {
  expect(playbookItems('- Уточнён период и фильтры отчёта\n* Проверено на другом пользователе\n\n[ ] Запрошен скриншот консоли\n1. Версия приложения')).toEqual([
    'Уточнён период и фильтры отчёта',
    'Проверено на другом пользователе',
    'Запрошен скриншот консоли',
    'Версия приложения',
  ]);
  expect(playbookItems('   \n\n')).toEqual([]);
});

test('срок "взять в работу": из настройки по приоритету, иначе срок первого ответа', () => {
  expect(pickupMinutes('p1', null, 15)).toBe(15);
  expect(pickupMinutes('p1', { p1: 30 }, 15)).toBe(30);
  expect(pickupMinutes('p2', { p1: 30 }, 60)).toBe(60);
  // Мусор в настройке не ломает срок.
  expect(pickupMinutes('p1', { p1: -5 }, 15)).toBe(15);
  expect(pickupMinutes('p1', { p1: 'час' }, 15)).toBe(15);
  expect(pickupMinutes('p1', 'всегда', 15)).toBe(15);
});
