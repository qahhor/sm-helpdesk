import { Pool } from 'pg';
import type { ClientActor, StaffActor, SystemActor } from '@/db/with-actor';

// Адреса задаёт tests/integration/setup/global-setup.ts.
const need = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`Интеграционные тесты: не задана переменная ${name}`);
  return value;
};

export const appUrl = need('DATABASE_URL_APP');

/** Прямые подключения под каждой ролью, в обход withActor. */
export const pools = {
  owner: new Pool({ connectionString: need('DATABASE_URL_OWNER'), max: 2 }),
  app: new Pool({ connectionString: appUrl, max: 2 }),
  auth: new Pool({ connectionString: need('DATABASE_URL_AUTH'), max: 2 }),
};

/** Сравнение версий вида 0.8.7: отрицательное число, если a меньше b. */
export function compareVersions(a: string, b: string): number {
  const left = a.split('.').map(Number);
  const right = b.split('.').map(Number);
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const diff = (left[i] ?? 0) - (right[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

export const admin: StaffActor = { type: 'staff', userId: 'staff-admin-1', staffRole: 'admin' };
export const agentL1: StaffActor = { type: 'staff', userId: 'staff-l1-1', staffRole: 'agent_l1' };
export const clientA: ClientActor = {
  type: 'client',
  userId: 'client-a-1',
  orgId: '019a1111-1111-7111-8111-111111111111',
  orgRole: 'client_user',
};
export const system: SystemActor = { type: 'system', job: 'integration-test' };
