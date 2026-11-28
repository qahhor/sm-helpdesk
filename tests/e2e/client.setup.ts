import { mkdirSync } from 'node:fs';
import { expect, test as setup } from '@playwright/test';
import { CLIENT_STATE, signInAs } from './helpers/client';
import { AUTH_DIR } from './helpers/staff';

// Клиент для браузерных тестов кабинета: вход через ложный сервер Smartup, как у настоящего клиента.
// Сессия сохраняется в tests/e2e/.auth/client.json и используется тестами, которым нужен вошедший клиент.
setup('клиент для браузерных тестов', async ({ browser }) => {
  mkdirSync(AUTH_DIR, { recursive: true });
  const context = await browser.newContext();
  const page = await context.newPage();
  await signInAs(page, 'alisher');
  await expect(page).toHaveURL(/\/ru$/);
  await expect(page.getByRole('banner')).toContainText('ACME Trade');
  // Выбор языка на устройстве, который ставит помощник входа, в общую сессию не сохраняется: тесты языка браузера
  // и переключателя идут от неё и ждут устройство без выбранного языка.
  await context.clearCookies({ name: 'hub_locale' });
  await context.storageState({ path: CLIENT_STATE });
  await context.close();
});
