import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, test } from '@playwright/test';
import { signInAsCustom, uniqueSub } from './helpers/client';
import { dbRows } from './helpers/db';

// Уведомления в портале (FR-NT-03, решение 5 вехи M4): колокольчик со счётчиком, список, отметка прочтения,
// настройки писем (FR-NT-04). У каждого теста свой клиент: проекты (телефон, ноутбук, узкий экран) идут
// параллельно и не должны менять уведомления и настройки друг друга. Обращение и уведомление ставятся прямо
// в базу: письма и события обращений проверяют интеграционные тесты, здесь проверяется то, что видит человек.
test.use({ storageState: { cookies: [], origins: [] } });

/** Новый клиент ACME Trade. Возвращает его идентификатор и организацию. */
async function freshClient(page: Page): Promise<{ userId: string; orgId: string }> {
  const name = `Колокольчик ${uniqueSub()}`;
  await signInAsCustom(page, { sub: uniqueSub(), name, company_id: '501', company_name: 'ACME Trade' });
  const [row] = await dbRows<{ user_id: string; org_id: string }>(
    `select m.user_id, m.org_id from hdu_memberships m join auth."user" u on u.id = m.user_id where u.name = $1 limit 1`,
    [name],
  );
  if (!row) throw new Error('клиент не найден');
  return { userId: row.user_id, orgId: row.org_id };
}

test('колокольчик показывает уведомление об ответе и сбрасывает счётчик после открытия', async ({ page }) => {
  const client = await freshClient(page);
  const [ticket] = await dbRows<{ ticket_id: string; number: string }>(
    `insert into hdt_tickets (org_id, author_id, type, impact, priority, visibility, title, description, locale, source)
     values ($1, $2, 'question', 'minor', 'p3', 'org', 'Колокольчик: проверка', 'Проверка уведомлений', 'ru', 'portal') returning ticket_id, number`,
    [client.orgId, client.userId],
  );
  if (!ticket) throw new Error('обращение не создано');
  await dbRows(`insert into hdn_notifications (org_id, user_id, ticket_id, kind, payload) values ($1, $2, $3, 'ticket_reply', $4)`, [
    client.orgId,
    client.userId,
    ticket.ticket_id,
    JSON.stringify({ number: Number(ticket.number) }),
  ]);

  await page.goto('/ru/tickets');
  const bell = page.getByRole('link', { name: 'Уведомления, новых: 1' });
  await expect(bell).toBeVisible();
  await expect(bell).toHaveAttribute('data-unread', '1');
  await bell.click();
  await expect(page).toHaveURL(/\/ru\/notifications$/);
  await expect(page.getByRole('heading', { name: 'Уведомления' })).toBeVisible();
  const axe = await new AxeBuilder({ page }).analyze();
  expect(axe.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical').map((v) => v.id)).toEqual([]);

  await page.getByRole('button', { name: new RegExp(`Ответ по обращению SUP-${ticket.number}`) }).click();
  await expect(page).toHaveURL(new RegExp(`/ru/tickets/SUP-${ticket.number}$`));
  // Счётчик обновляется при переходе: раскладка не перерисовывается, число запрашивается заново.
  await expect(page.getByRole('link', { name: 'Уведомления, новых нет' })).toBeVisible();
  await page.goto('/ru/notifications');
  await expect(page.getByText('Новое', { exact: true })).toHaveCount(0);
});

test('каналы уведомлений: без Telegram почту о своих обращениях не выключить, об обращениях коллег переключается', async ({ page }) => {
  await freshClient(page);
  await page.goto('/ru/settings');
  const ownEmail = () => page.getByRole('checkbox', { name: 'О своих обращениях Почта' });
  const watchedEmail = () => page.getByRole('checkbox', { name: 'Об обращениях коллег, на которые я подписан Почта' });
  await expect(ownEmail()).toBeChecked();
  await expect(page.getByRole('checkbox', { name: 'О своих обращениях Telegram' })).toBeChecked();
  await expect(page.getByText('Telegram не привязан.')).toBeVisible();
  await watchedEmail().uncheck();
  await page.getByRole('button', { name: 'Сохранить' }).click();
  await expect(page.getByText('Сохранено')).toBeVisible();
  await expect(watchedEmail()).not.toBeChecked();
  // Без привязки Telegram почту о своих обращениях выключить нельзя: сервер отказывает и объясняет почему.
  await ownEmail().uncheck();
  await page.getByRole('button', { name: 'Сохранить' }).click();
  await expect(page.getByRole('main').getByRole('alert')).toContainText('Письма о своих обращениях выключаются, только если Telegram привязан');
  await expect(ownEmail()).toBeChecked();
});
