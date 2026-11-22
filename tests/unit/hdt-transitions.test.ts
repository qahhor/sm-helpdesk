import { expect, test } from 'vitest';
import { allowedStaffTransitions, canTransition, TICKET_STATUSES } from '@/modules/hdt/pref';

// Разрешённые переходы статуса обращения: ровно таблица раздела 7.2 ТЗ.
const ALLOWED = [
  'new>in_progress',
  'new>waiting_customer',
  'in_progress>waiting_customer',
  'waiting_customer>in_progress',
  'in_progress>in_development',
  'in_development>in_progress',
  'in_progress>resolved',
  'in_development>resolved',
  'waiting_customer>resolved',
  'waiting_customer>closed',
  'resolved>closed',
  'resolved>in_progress',
  'closed>in_progress',
];

test('из 36 пар статусов разрешены ровно 13 переходов раздела 7.2', () => {
  const allowed: string[] = [];
  for (const from of TICKET_STATUSES) for (const to of TICKET_STATUSES) if (canTransition(from, to)) allowed.push(`${from}>${to}`);
  expect(allowed.sort()).toEqual([...ALLOWED].sort());
});

test('сотруднику предлагаются только его переходы: "В разработке" нет у первой линии и у product', () => {
  expect(allowedStaffTransitions('in_progress', 'agent_l1')).toEqual(['waiting_customer', 'resolved']);
  expect(allowedStaffTransitions('in_progress', 'agent_l2')).toEqual(['waiting_customer', 'in_development', 'resolved']);
  expect(allowedStaffTransitions('closed', 'care')).toEqual(['in_progress']);
  expect(allowedStaffTransitions('in_progress', 'product')).toEqual([]);
  // Закрывает сотрудник только решённое (решение 5 плана M3): из ожидания клиента закрывает задача.
  expect(allowedStaffTransitions('waiting_customer', 'agent_l1')).toEqual(['in_progress', 'resolved']);
  expect(allowedStaffTransitions('resolved', 'agent_l1')).toEqual(['closed', 'in_progress']);
  // Объединённое закрыто навсегда (решение 4).
  expect(allowedStaffTransitions('closed', 'care', { merged: true })).toEqual([]);
});
