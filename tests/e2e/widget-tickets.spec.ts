import { expect, test } from '@playwright/test';
import { dbRows } from './helpers/db';
import { openHost, useMockContextKeys, WIDGET_LAUNCH, widgetFrame, widgetPersona } from './helpers/widget';

// "Мои обращения" в панели виджета (план M6, задача 6; FR-WG-06, решение 13): переход из "Сообщить" без потери
// токена (раскладка с токеном не пересоздаётся), переписка без внутренних заметок, ответ из панели.

test.use({ launchOptions: WIDGET_LAUNCH });

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
