import { type Browser, expect, test } from '@playwright/test';
import { dbRows } from './helpers/db';
import { storageStateOf } from './helpers/staff';
import { blockThirdPartyCookies, openHost, useMockContextKeys, widgetFrame, widgetPersona } from './helpers/widget';

// "Мои обращения" в панели виджета (план M6, задача 6; FR-WG-06, решение 13): переход из "Сообщить" без потери
// токена (раскладка с токеном не пересоздаётся), переписка без внутренних заметок, ответ из панели.

test.beforeEach(blockThirdPartyCookies);

test('после отправки: мои обращения, страница обращения с ответом поддержки, без внутренней заметки', async ({ page }, info) => {
  test.skip(info.project.name !== 'desktop', 'экран один на всех ширинах, телефон проверяет /m/report');
  const key = await useMockContextKeys();
  await openHost(page, { key, persona: widgetPersona() });
  await page.evaluate(() => (window as unknown as { SmartupHub: { open(): void } }).SmartupHub.open());
  const frame = await widgetFrame(page, '/ru/embed/report');
  await frame.getByLabel('Что вы делали перед ошибкой?').fill('Не печатается накладная из заказа');
  await frame.getByRole('button', { name: 'Отправить обращение' }).click();
  await expect(frame.getByTestId('widget-created')).toBeVisible();
  const number = Number(/SUP-(\d+)/.exec((await frame.getByTestId('widget-created').textContent()) ?? '')?.[1]);

  // Ответ поддержки и внутренняя заметка в базе: клиенту видна только первая.
  const [ticket] = await dbRows<{ ticket_id: string; org_id: string }>(`select ticket_id, org_id from hdt_tickets where number = $1`, [number]);
  await dbRows(
    `insert into hdt_ticket_messages (org_id, ticket_id, author_id, author_type, body, is_internal)
     select $1, $2, s.user_id, 'staff', v.body, v.internal from (select user_id from hdu_staff limit 1) s,
       (values ('Проверьте формат бумаги', false), ('Внутренняя заметка виджета', true)) as v(body, internal)`,
    [ticket?.org_id, ticket?.ticket_id],
  );

  await frame.getByRole('button', { name: 'Открыть мои обращения' }).click();
  await expect(frame.getByTestId('widget-ticket')).toBeVisible();
  expect(frame.url()).toMatch(new RegExp(`/ru/embed/tickets/${number}\\?key=${key}&origin=`));
  await expect(frame.getByText('Проверьте формат бумаги')).toBeVisible();
  await expect(frame.locator('[data-author="support"]')).toContainText('Поддержка Smartup');
  await expect(frame.getByText('Внутренняя заметка виджета')).toHaveCount(0);

  await frame.getByLabel('Ответ').fill('Формат A4, всё равно не печатается');
  await frame.getByRole('button', { name: 'Отправить', exact: true }).click();
  await expect(frame.getByText('Формат A4, всё равно не печатается')).toBeVisible();

  // Вкладка "Мои обращения": переход внутри фрейма, токен в памяти сохранился.
  await frame.getByRole('button', { name: 'Мои обращения' }).click();
  await expect(frame.getByTestId('widget-tickets')).toContainText(`SUP-${number}`);
  await expect(frame.getByRole('link', { name: 'Открыть в портале' })).toHaveCount(0);
});

type Published = { article_id: string; article_number: number; title: string };
const AI_SOLUTION_TITLE = 'Накладная печатается пустым листом: формат бумаги';
const publishedForClients = () =>
  dbRows<Published>(`select article_id, article_number, title from hdk_published where audience = 'clients' and locale = 'ru' and title = $1 limit 1`, [AI_SOLUTION_TITLE]).then((rows) => rows[0]);

/** Опубликованное решение для клиентов: на свежей базе его публикует сотрудник второй линии через редактор. */
async function clientSolution(browser: Browser): Promise<Published> {
  const found = await publishedForClients();
  if (found) return found;
  await dbRows(`insert into hdr_product_modules (code, name) values ('e2e-widget-ai', '{"ru": "Печать (виджет AI)", "uz": "Chop etish (vidjet AI)", "en": "Printing (widget AI)"}') on conflict (code) do nothing`);
  const context = await browser.newContext({ storageState: storageStateOf('l2') });
  const page = await context.newPage();
  await page.goto('/ru/agent/solutions/new');
  await page.getByLabel('Заголовок').fill(AI_SOLUTION_TITLE);
  await page.getByLabel('Модуль').selectOption({ label: 'Печать (виджет AI)' });
  await page.getByRole('button', { name: 'Создать' }).click();
  await expect(page).toHaveURL(/\/ru\/agent\/solutions\/\d+$/);
  const editor = page.locator('.doc-editor');
  await editor.locator(':scope > p').first().click();
  await page.keyboard.type('Накладная выходит пустым листом, если выбран другой формат бумаги.');
  await editor.locator('.node-step p').first().click();
  await page.keyboard.type('Откройте настройки печати и выберите формат бумаги по размеру листа');
  await expect(page.getByTestId('save-status')).toHaveText(/Сохранено в/, { timeout: 15_000 });
  await page.getByTestId('solution-review').getByRole('button', { name: 'Опубликовать' }).click();
  await expect(page.getByText('Решение опубликовано.')).toBeVisible({ timeout: 15_000 });
  await context.close();
  const published = await publishedForClients();
  if (!published) throw new Error('решение для теста виджета не опубликовано');
  return published;
}

// Волна 7, T1 (FR-AI-08, раздел 8.6 ТЗ): ответ AI-помощника в виджете показан видом Теза, а не как "Поддержка Smartup".
test('ответ AI-помощника в виджете: Тез, "Ответ подготовлен AI", кнопки; "Нужен сотрудник" передаёт обращение', async ({ page, browser }, info) => {
  test.setTimeout(120_000);
  test.skip(info.project.name !== 'desktop', 'экран один на всех ширинах, телефон проверяет /m/report');
  const key = await useMockContextKeys();
  await openHost(page, { key, persona: widgetPersona() });
  await page.evaluate(() => (window as unknown as { SmartupHub: { open(): void } }).SmartupHub.open());
  const frame = await widgetFrame(page, '/ru/embed/report');
  await frame.getByLabel('Что вы делали перед ошибкой?').fill('Накладная печатается пустым листом');
  await frame.getByRole('button', { name: 'Отправить обращение' }).click();
  await expect(frame.getByTestId('widget-created')).toBeVisible();
  const number = Number(/SUP-(\d+)/.exec((await frame.getByTestId('widget-created').textContent()) ?? '')?.[1]);

  // Опубликованное решение для клиентов и ответ помощника им: строку пишет система, как задача первой линии.
  const solution = await clientSolution(browser);
  const [ticket] = await dbRows<{ ticket_id: string; org_id: string }>(`select ticket_id, org_id from hdt_tickets where number = $1`, [number]);
  const payload = JSON.stringify({ kind: 'answer', introId: 'likely_solution', articleId: solution.article_id, articleNumber: Number(solution.article_number), locale: 'ru' });
  if (!/^[0-9a-f-]{36}$/.test(ticket!.ticket_id) || !/^[0-9a-f-]{36}$/.test(ticket!.org_id) || payload.includes("'")) throw new Error('неожиданные данные набора');
  await dbRows(
    `begin; select set_config('app.actor_type', 'system', true);
     insert into hdt_ticket_messages (org_id, ticket_id, author_type, body, ai_payload) values ('${ticket!.org_id}', '${ticket!.ticket_id}', 'ai', 'Тез', '${payload}'::jsonb);
     update hdt_tickets set ai_state = 'active', ai_reply_count = 1, status = 'waiting_customer' where ticket_id = '${ticket!.ticket_id}';
     commit;`,
  );

  await frame.getByRole('button', { name: 'Открыть мои обращения' }).click();
  const message = frame.getByTestId('tez-message');
  await expect(message).toBeVisible();
  await expect(message).toHaveAttribute('data-author', 'ai');
  await expect(message).toContainText('Тез · AI-ассистент');
  await expect(message).toContainText('Ответ подготовлен AI');
  await expect(message).toContainText(solution.title);
  await expect(message.locator('[data-tez] img').first()).toBeAttached();
  // Ответ помощника не подписан поддержкой.
  await expect(frame.locator('[data-author="support"]')).toHaveCount(0);
  const actions = message.getByTestId('tez-actions');
  for (const name of ['Помогло', 'Не помогло', 'Нужен сотрудник']) await expect(actions.getByRole('button', { name, exact: true })).toBeVisible();

  await actions.getByRole('button', { name: 'Нужен сотрудник', exact: true }).click();
  // Передача: сообщение помощника о передаче, кнопок больше нет, обращение у сотрудников.
  await expect(frame.getByText('Передал обращение сотруднику.')).toBeVisible();
  await expect(frame.getByTestId('tez-actions')).toHaveCount(0);
  expect((await dbRows<{ ai_state: string; ai_handoff_reason: string }>(`select ai_state, ai_handoff_reason from hdt_tickets where number = $1`, [number]))[0]).toEqual({ ai_state: 'handed_off', ai_handoff_reason: 'customer_request' });
});
