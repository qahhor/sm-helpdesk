import { mkdirSync, writeFileSync } from 'node:fs';
import { test as setup } from '@playwright/test';
import { acceptAndEnroll, AUTH_DIR, createStaffInvitation, type E2eStaff, staffFile, type StaffKey, storageStateOf } from './helpers/staff';

// Сотрудники для браузерных тестов: по одному на роль. Каждый проходит путь настоящего сотрудника:
// ссылка приглашения, свой пароль, подключение второго фактора. Сессия сохраняется для тестов рабочего места.

const ACCOUNTS: { key: StaffKey; name: string; role: string }[] = [
  { key: 'care', name: 'Камила', role: 'care' },
  { key: 'l1', name: 'Азиз', role: 'agent_l1' },
  { key: 'admin', name: 'Рустам', role: 'admin' },
];

setup('сотрудники для браузерных тестов', async ({ browser }) => {
  mkdirSync(AUTH_DIR, { recursive: true });
  const run = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const saved: Partial<Record<StaffKey, E2eStaff>> = {};
  for (const account of ACCOUNTS) {
    const email = `e2e-${account.key}-${run}@smartup.example`;
    const password = `e2e-${account.key}-${run}-password`;
    const token = createStaffInvitation({ email, name: account.name, role: account.role });
    const context = await browser.newContext();
    const page = await context.newPage();
    const totpSecret = await acceptAndEnroll(page, { token, email, password });
    await context.storageState({ path: storageStateOf(account.key) });
    await context.close();
    saved[account.key] = { ...account, email, password, totpSecret };
  }
  writeFileSync(staffFile, JSON.stringify(saved, null, 2));
});
