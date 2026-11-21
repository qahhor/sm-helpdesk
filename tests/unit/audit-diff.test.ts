import { expect, test } from 'vitest';
import { diffLines } from '@/app/[locale]/(agent)/agent/settings/audit/diff';

// Изменения в журнале аудита выводятся словами интерфейса, а не кодами (проверка main, Q14).
const words: Record<string, string> = { role: 'Роль', client_admin: 'Администратор клиента', client_user: 'Пользователь', source: 'Откуда', smartup: 'Smartup', true: 'да', name: 'Название' };
const label = (raw: string) => words[raw] ?? raw;

test('поле и значения переводятся, неизвестное остаётся как есть', () => {
  expect(diffLines({ role: { from: 'client_user', to: 'client_admin' }, source: 'smartup' }, label, 'нет')).toEqual([
    'Роль: Пользователь → Администратор клиента',
    'Откуда: Smartup',
  ]);
  expect(diffLines({ isLead: true, changed: ['name', 'baseUrl'], others: 2, step: null }, label, 'нет')).toEqual([
    'isLead: да',
    'changed: Название, baseUrl',
    'others: 2',
    'step: нет',
  ]);
  expect(diffLines(null, label, 'нет')).toEqual([]);
});

test('вложенный объект выводится текстом без разметки', () => {
  expect(diffLines({ roleMap: { director: 'client_admin' } }, label, 'нет')).toEqual(['roleMap: {"director":"client_admin"}']);
});
