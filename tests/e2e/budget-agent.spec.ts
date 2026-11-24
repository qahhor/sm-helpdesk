import { type Page, expect, test } from '@playwright/test';
import { sumScriptBytes } from '../../scripts/checks/budget-rules.mjs';
import { dbRows } from './helpers/db';
import { storageStateOf } from './helpers/staff';

// Бюджет скриптов первого экрана рабочего места (аудит 23.11.2026, раздел 4.3; план W3, задача 6). Для кабинета
// клиента предел 170 КБ задаёт ТЗ 8.9. Рабочее место открывают с ноутбука в офисе, и скриптов на нём больше:
// клавиатура, палитра команд, редактор ответа. Предел поставлен по замеру с запасом 10% (решение 0040, пункт 10):
// он ловит рост, а не задаёт цель. Превышение разбирается, а не лечится поднятием предела.
// Замер 24.11.2026: очередь 187 КБ, страница обращения 192 КБ.
const AGENT_BUDGET_BYTES = 212 * 1024;

test.use({ storageState: storageStateOf('l1') });

async function scriptsOf(page: Page, path: string, ready: () => Promise<void>): Promise<number> {
  const pending: Promise<{ url: string; resourceType: string; encodedBytes: number }>[] = [];
  page.on('requestfinished', (request) => {
    pending.push(request.sizes().then((sizes) => ({ url: request.url(), resourceType: request.resourceType(), encodedBytes: sizes.responseBodySize })));
  });
  await page.goto(path, { waitUntil: 'networkidle' });
  await ready();
  return sumScriptBytes(await Promise.all(pending));
}

test('очередь сотрудника укладывается в бюджет скриптов', async ({ page }, info) => {
  test.skip(info.project.name !== 'desktop', 'рабочее место проверяется на ноутбуке');
  const total = await scriptsOf(page, '/ru/agent/queues?queue=all', async () => {
    await expect(page.getByRole('main')).toBeVisible();
  });
  console.log(`Скрипты очереди сотрудника: ${Math.round(total / 1024)} КБ из ${Math.round(AGENT_BUDGET_BYTES / 1024)}`);
  expect(total).toBeLessThanOrEqual(AGENT_BUDGET_BYTES);
});

test('страница обращения сотрудника укладывается в бюджет скриптов', async ({ page }, info) => {
  test.skip(info.project.name !== 'desktop', 'рабочее место проверяется на ноутбуке');
  const [row] = await dbRows<{ number: number }>(`select number from hdt_tickets where status <> 'closed' and merged_into_id is null order by created_on desc limit 1`);
  const total = await scriptsOf(page, `/ru/agent/tickets/SUP-${row!.number}`, async () => {
    await expect(page.getByRole('main')).toBeVisible();
  });
  console.log(`Скрипты обращения сотрудника: ${Math.round(total / 1024)} КБ из ${Math.round(AGENT_BUDGET_BYTES / 1024)}`);
  expect(total).toBeLessThanOrEqual(AGENT_BUDGET_BYTES);
});
