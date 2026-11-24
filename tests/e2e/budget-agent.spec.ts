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

// Редактор решения (план M5, задача 3; решение 0046): первый экран без файла редактора укладывается в тот же бюджет,
// редактор (Tiptap и ProseMirror) догружается после показа страницы и считается отдельно. Файл редактора узнаётся по
// содержимому: строка класса ProseMirror-hideselection и имя расширения stableIds.
const EDITOR_MARKERS = ['ProseMirror-hideselection', 'stableIds'];

test('редактор решения: первый экран без файла редактора укладывается в бюджет скриптов', async ({ page }, info) => {
  test.skip(info.project.name !== 'desktop', 'рабочее место проверяется на ноутбуке');
  let [row] = await dbRows<{ number: number }>(`select number from hdk_articles where status = 'active' order by created_on desc limit 1`);
  if (!row) {
    // Решения ещё нет (тест идёт один): заводится строками, как его создал бы сотрудник.
    const [article] = await dbRows<{ number: number; article_id: string }>(`insert into hdk_articles (original_locale) values ('ru') returning number, article_id`);
    row = article;
    const [version] = await dbRows<{ version_id: string }>(
      `insert into hdk_article_versions (article_id, locale, number, title, doc) values ($1, 'ru', 1, 'Бюджет', '{"version":1,"blocks":[]}') returning version_id`,
      [article!.article_id],
    );
    await dbRows(`insert into hdk_article_translations (article_id, locale, draft_version_id) values ($1, 'ru', $2)`, [article!.article_id, version!.version_id]);
  }
  const scripts: Promise<{ url: string; resourceType: string; encodedBytes: number; body: string }>[] = [];
  page.on('requestfinished', (request) => {
    if (request.resourceType() !== 'script') return;
    scripts.push(
      (async () => ({ url: request.url(), resourceType: 'script', encodedBytes: (await request.sizes()).responseBodySize, body: (await (await request.response())?.text()) ?? '' }))(),
    );
  });
  await page.goto(`/ru/agent/solutions/${row!.number}`, { waitUntil: 'networkidle' });
  await expect(page.locator('.doc-editor')).toBeVisible();
  await page.waitForLoadState('networkidle');
  const all = await Promise.all(scripts);
  const editor = all.filter((s) => EDITOR_MARKERS.some((marker) => s.body.includes(marker)));
  expect(editor.length).toBeGreaterThan(0);
  const firstScreen = sumScriptBytes(all) - sumScriptBytes(editor);
  console.log(`Скрипты редактора решения: первый экран ${Math.round(firstScreen / 1024)} КБ из ${Math.round(AGENT_BUDGET_BYTES / 1024)}, редактор ${Math.round(sumScriptBytes(editor) / 1024)} КБ`);
  expect(firstScreen).toBeLessThanOrEqual(AGENT_BUDGET_BYTES);
});
