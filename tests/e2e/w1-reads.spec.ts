import { type Browser, expect, test } from '@playwright/test';
import { CLIENT_STATE, signInAsCustom, uniqueSub } from './helpers/client';
import { dbRows } from './helpers/db';
import { staffAccount, storageStateOf } from './helpers/staff';

// Запрос GET ничего не меняет в предметных данных (аудит 23.11.2026, находки A5 и S13): отметку "просмотрено"
// ставит действие страницы, код привязки Telegram не создаётся запросом с чужого сайта и предзагрузкой.

test.beforeEach(({}, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'проверяется один раз, на ноутбуке');
});

async function clientTicket(browser: Browser, description: string): Promise<number> {
  const context = await browser.newContext({ storageState: CLIENT_STATE });
  const page = await context.newPage();
  await page.goto('/ru/tickets/new');
  await expect(page.locator('form[data-ready]').first()).toBeAttached();
  await page.getByLabel('Что случилось?').fill(description);
  await dbRows(`delete from hdc_rate_limits where code like 'ticket-create:user:%'`);
  await page.getByRole('button', { name: 'Отправить обращение' }).click();
  await expect(page).toHaveURL(/\/ru\/tickets\/SUP-\d+/);
  const number = Number(/SUP-(\d+)/.exec(page.url())?.[1]);
  await context.close();
  return number;
}

test.describe('обращение у сотрудника', () => {
  test.use({ storageState: storageStateOf('l1') });

  test('чтение страницы запросом отметку "просмотрено" не ставит, открытие в браузере ставит', async ({ page, browser }) => {
    const number = await clientTicket(browser, `Отметка просмотра ${uniqueSub()}`);
    const staffId = (await dbRows<{ id: string }>(`select id from auth."user" where email = $1`, [staffAccount('l1').email]))[0]?.id;
    const marks = () =>
      dbRows<{ seen_on: Date | null; view_logged_on: Date | null }>(
        `select r.seen_on, r.view_logged_on from hdt_ticket_reads r join hdt_tickets t using (ticket_id) where t.number = $1 and r.user_id = $2`,
        [number, staffId],
      );
    // Так страницу читает предзагрузка ссылки или картинка на чужой странице: скрипты не выполняются.
    const plain = await page.request.get(`/ru/agent/tickets/SUP-${number}`);
    expect(plain.status()).toBe(200);
    const afterPlain = await marks();
    expect(afterPlain).toHaveLength(1);
    expect(afterPlain[0]?.seen_on).toBeNull();
    // Само чтение в журнал аудита записано: оно от скриптов не зависит.
    expect(afterPlain[0]?.view_logged_on).not.toBeNull();

    await page.goto(`/ru/agent/tickets/SUP-${number}`);
    await expect.poll(async () => (await marks())[0]?.seen_on ?? null).not.toBeNull();
  });
});

test('код привязки Telegram не создаётся запросом с чужого сайта и предзагрузкой', async ({ page }) => {
  await signInAsCustom(page, { sub: uniqueSub(), name: 'Чужой сайт', company_id: '501', company_name: 'ACME Trade' });
  const userId = (await dbRows<{ id: string }>(`select "userId" as id from auth.session order by "createdAt" desc limit 1`))[0]?.id;
  const codes = async () => (await dbRows<{ n: number }>(`select count(*)::int as n from hdu_link_codes where user_id = $1`, [userId]))[0]?.n ?? -1;
  const before = await codes();
  const foreign: Record<string, string>[] = [
    { 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'navigate' },
    { 'sec-fetch-site': 'same-origin', 'sec-purpose': 'prefetch' },
  ];
  for (const headers of foreign) {
    const response = await page.request.get('/ru/settings/telegram', { maxRedirects: 0, headers });
    expect(response.status()).toBe(303);
    expect(new URL(response.headers().location ?? '').pathname).toBe('/ru/settings');
  }
  expect(await codes()).toBe(before);
  // Свой переход работает как раньше.
  const own = await page.request.get('/ru/settings/telegram', { maxRedirects: 0, headers: { 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'navigate' } });
  expect(new URL(own.headers().location ?? '').origin).toBe('https://t.me');
  expect(await codes()).toBe(before + 1);
});
