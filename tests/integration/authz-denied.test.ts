import { afterEach, expect, test } from 'vitest';
import type { StaffContext } from '@/modules/hdc/api';
import { setLogSinkForTests } from '@/lib/log';
import { staffAccess } from '@/modules/hdu/api/session';

// Отказ в доступе к рабочему месту пишется в журнал процесса (ASVS 5.0.0, требование 16.3.2; план подготовки M9,
// задача 1): не сотрудник открыл рабочее место или сотрудник без нужной роли открыл раздел. Человеку при этом 404.
// Нет входа, нет второго фактора или сессия истекла: это не отказ, а страница входа, в журнал не пишется.

const events: { level: string; event: string; fields?: Record<string, unknown> }[] = [];
afterEach(() => {
  setLogSinkForTests(null);
  events.length = 0;
});
const listen = () => setLogSinkForTests((level, event, fields) => void events.push({ level, event, fields: fields as Record<string, unknown> }));

const staff = (role: StaffContext['actor']['staffRole']): StaffContext => ({
  actor: { type: 'staff', userId: '0192d2a4-0000-7000-8000-00000000000a', staffRole: role },
  user: { id: '0192d2a4-0000-7000-8000-00000000000a', name: 'Камила', email: 'kamila@smartup.example' },
  isLead: false,
  sessionCreatedAt: new Date(),
});

test('сотрудник с нужной ролью проходит, в журнале ничего', () => {
  listen();
  expect(staffAccess(staff('admin'), ['admin'])).toBe('ok');
  expect(staffAccess(staff('agent_l1'))).toBe('ok');
  expect(events).toEqual([]);
});

test('роль не подходит: 404 и запись authz.denied с ролью и разделом, без адреса и имени', () => {
  listen();
  expect(staffAccess(staff('agent_l1'), ['admin'])).toBe('not_found');
  expect(events).toEqual([
    { level: 'warn', event: 'authz.denied', fields: { area: 'agent', reason: 'role', userId: '0192d2a4-0000-7000-8000-00000000000a', role: 'agent_l1', need: 'admin' } },
  ]);
  expect(JSON.stringify(events)).not.toContain('kamila');
});

test('не сотрудник: 404 и запись; без входа и без второго фактора: страница входа без записи', () => {
  listen();
  expect(staffAccess({ denied: 'not_staff' }, undefined, '0192d2a4-0000-7000-8000-00000000000b')).toBe('not_found');
  expect(events).toEqual([{ level: 'warn', event: 'authz.denied', fields: { area: 'agent', reason: 'not_staff', userId: '0192d2a4-0000-7000-8000-00000000000b' } }]);
  for (const denied of ['no_session', 'no_second_factor', 'expired'] as const) expect(staffAccess({ denied })).toBe('sign_in');
  expect(events).toHaveLength(1);
});
