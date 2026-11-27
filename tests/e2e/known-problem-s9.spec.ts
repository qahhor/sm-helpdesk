import { type Browser, expect, type Page, test } from '@playwright/test';
import { CLIENT_STATE } from './helpers/client';
import { dbRows } from './helpers/db';
import { storageStateOf } from './helpers/staff';

// Сценарий S9 "Массовая ошибка" (ТЗ 15.3, сценарий 13; FR-KP-03, 04, 06, 07, 08; план M5c, задача 5) на заглушке модели:
// пять обращений с одной ошибкой, вторая линия создаёт проблему из первого и привязывает остальные, шестое обращение
// привязывается само и видит баннер, одно обновление получают все шесть, закрытие переводит все в "Решено" с итоговым
// сообщением. Рассылку выполняет фоновый процесс браузерных тестов. База общая: прежние проблемы теста закрываются.

test.beforeEach(({}, info) => {
  test.skip(info.project.name !== 'desktop', 'сценарий целиком на ноутбуке');
});
test.use({ storageState: storageStateOf('l2') });

const ERROR = 'ORA-20777: Склад ГЛАВНЫЙ не найден для документа №42';
const resetLimits = () => dbRows(`delete from hdc_rate_limits where code like 'ticket-create:user:%' or code like 'kb-suggest:%'`);
const main = (page: Page) => page.getByRole('main');

async function clientTicket(browser: Browser, description: string, opts: { expectBanner?: boolean } = {}): Promise<number> {
  const context = await browser.newContext({ storageState: CLIENT_STATE });
  const page = await context.newPage();
  await page.goto('/ru/tickets/new');
  await expect(page.locator('form[data-ready]').first()).toBeAttached();
  await resetLimits();
  await page.getByLabel('Что случилось?').fill(description);
  if (opts.expectBanner) await expect(page.getByTestId('known-problem-banner')).toBeVisible();
  await page.getByRole('button', { name: 'Отправить обращение' }).click();
  await expect(page).toHaveURL(/\/ru\/tickets\/SUP-\d+/);
  const number = Number(/SUP-(\d+)/.exec(page.url())?.[1]);
  if (opts.expectBanner) await expect(page.getByTestId('ticket-known-problem')).toBeVisible();
  await context.close();
  return number;
}

test('S9: пять обращений, проблема из первого, автопривязка шестого, одно обновление всем, закрытие переводит в "Решено"', async ({ page, browser }) => {
  test.setTimeout(240_000);
  const stamp = Date.now();
  await dbRows(`update hdp_problems p set status = 'closed' from hdp_problem_signatures s where s.problem_id = p.problem_id and p.status <> 'closed' and p.internal_title like 'S9 %'`);
  const numbers: number[] = [];
  for (let i = 1; i <= 5; i++) numbers.push(await clientTicket(browser, `S9 ${stamp}: не проводится документ ${i}.\n${ERROR}`));
  // Сигнатура уже могла принадлежать прошлой активной проблеме: закрываем такие, чтобы проверить создание заново.
  const [sig] = await dbRows<{ error_signature: string }>(`select error_signature from hdt_tickets where number = $1`, [numbers[0]]);
  await dbRows(
    `update hdp_problems p set status = 'closed' from hdp_problem_signatures s where s.problem_id = p.problem_id and s.signature = $1 and p.status <> 'closed'`,
    [sig!.error_signature],
  );
  await dbRows(`update hdt_tickets set known_problem_id = null where number = any($1)`, [numbers]);

  // Вторая линия создаёт проблему из первого обращения.
  await page.goto(`/ru/agent/tickets/SUP-${numbers[0]}`);
  await page.locator('[data-known-problem]').getByRole('button', { name: 'Создать известную проблему' }).click();
  await expect(page).toHaveURL(/\/ru\/agent\/problems\/\d+\?status=created/);
  const problem = Number(/problems\/(\d+)/.exec(page.url())?.[1]);
  await dbRows(`update hdp_problems set internal_title = $2 where number = $1`, [problem, `S9 ${stamp}`]);
  const ru = main(page).locator('[data-locale="ru"]');
  await ru.getByLabel('Публичное название').fill(`Не находится склад ${stamp.toString(36)}`);
  await ru.getByLabel('Что происходит').fill('После обновления документы не проводятся: склад не находится. Исправляем.');
  await ru.getByRole('button', { name: 'Сохранить текст' }).click();
  await expect(main(page).getByText('Текст сохранён')).toBeVisible();
  await main(page).getByRole('button', { name: 'Показать клиентам' }).click();
  await expect(main(page).getByText('Проблема показывается клиентам')).toBeVisible();

  // Остальные четыре привязываются из обращения.
  for (const number of numbers.slice(1)) {
    await page.goto(`/ru/agent/tickets/SUP-${number}`);
    const block = page.locator('[data-known-problem]');
    await block.getByLabel('Привязать к проблеме').fill(`KP-${problem}`);
    await block.getByRole('button', { name: 'Привязать', exact: true }).click();
    await expect(page).toHaveURL(/done=problem_linked/);
  }

  // Шестое обращение: баннер над формой, после отправки привязано само и показывает блок проблемы.
  const sixth = await clientTicket(browser, `S9 ${stamp}: и у нас тоже.\n${ERROR}`, { expectBanner: true });
  numbers.push(sixth);
  const linkedCount = async () =>
    Number((await dbRows<{ n: string }>(`select count(*) as n from hdt_tickets t join hdp_problems p on p.problem_id = t.known_problem_id where p.number = $1 and t.number = any($2)`, [problem, numbers]))[0]!.n);
  expect(await linkedCount()).toBe(6);

  // Одно обновление всем: экран подтверждения с числом получателей.
  await page.goto(`/ru/agent/problems/${problem}?tab=updates`);
  await main(page).getByLabel('Текст обновления').fill('Нашли причину, исправление выйдет сегодня.');
  await main(page).getByRole('button', { name: 'Проверить и подготовить' }).click();
  await expect(page.getByTestId('broadcast-recipients')).toContainText('Получат: 6 обращений');
  await main(page).getByRole('button', { name: 'Подтвердить и отправить' }).click();
  await expect(page).toHaveURL(/status=broadcast_sent/);
  const updated = async (body: string) =>
    Number((await dbRows<{ n: string }>(`select count(distinct m.ticket_id) as n from hdt_ticket_messages m join hdt_tickets t on t.ticket_id = m.ticket_id where m.broadcast_id is not null and m.body = $1 and t.number = any($2)`, [body, numbers]))[0]!.n);
  await expect.poll(() => updated('Нашли причину, исправление выйдет сегодня.'), { timeout: 60_000 }).toBe(6);

  // Клиент видит сообщение с пометкой "Обновление по известной проблеме".
  const client = await browser.newContext({ storageState: CLIENT_STATE });
  const clientPage = await client.newPage();
  await clientPage.goto(`/ru/tickets/SUP-${numbers[2]}`);
  await expect(clientPage.getByText('Нашли причину, исправление выйдет сегодня.')).toBeVisible();
  await expect(clientPage.getByText('Обновление по известной проблеме')).toBeVisible();

  // Закрытие: итоговое сообщение, все шесть в "Решено".
  await page.goto(`/ru/agent/problems/${problem}?tab=updates`);
  await main(page).getByLabel('Итоговый текст').fill('Исправлено. Проверьте, пожалуйста, проведение документов.');
  await main(page).getByRole('button', { name: 'Подготовить закрытие' }).click();
  await main(page).getByRole('button', { name: 'Подтвердить закрытие' }).click();
  await expect(page).toHaveURL(/status=broadcast_sent/);
  await expect
    .poll(async () => (await dbRows<{ status: string }>(`select status from hdt_tickets where number = any($1)`, [numbers])).map((r) => r.status).sort().join(','), { timeout: 60_000 })
    .toBe(Array(6).fill('resolved').join(','));
  expect(await updated('Исправлено. Проверьте, пожалуйста, проведение документов.')).toBe(6);
  expect((await dbRows<{ status: string }>(`select status from hdp_problems where number = $1`, [problem]))[0]!.status).toBe('closed');
  await clientPage.goto(`/ru/tickets/SUP-${numbers[5]}`);
  await expect(clientPage.getByText('Исправлено. Проверьте, пожалуйста, проведение документов.')).toBeVisible();
  await client.close();
});
