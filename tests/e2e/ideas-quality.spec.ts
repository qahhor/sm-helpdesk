import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, test } from '@playwright/test';
import { CLIENT_STATE } from './helpers/client';
import { dbRows } from './helpers/db';
import { storageStateOf } from './helpers/staff';

// Качество страниц идей (план M7, задача 10; ТЗ 8.12, 15.3 сценарий 8, раздел 16 "доступность"): ноль серьёзных
// замечаний axe на четырёх страницах клиента и трёх сотрудника, без горизонтальной прокрутки на трёх ширинах (360,
// 768, 1280), переключение языка без имён ключей вместо текста. Ширины задаются здесь, поэтому файл идёт в одном проекте.

test.beforeEach(({}, info) => {
  test.skip(info.project.name !== 'desktop', 'ширины задаются в самом тесте');
});

const WIDTHS = [360, 768, 1280] as const;

async function check(page: Page, path: string, ready: (page: Page) => Promise<void>): Promise<void> {
  for (const width of WIDTHS) {
    await page.setViewportSize({ width, height: 800 });
    await page.goto(path);
    await ready(page);
    const fits = await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
    expect(fits, `${path} на ширине ${width}: горизонтальная прокрутка`).toBe(true);
    const { violations } = await new AxeBuilder({ page }).analyze();
    expect(
      violations.filter((v) => ['serious', 'critical'].includes(v.impact ?? '')).map((v) => v.id),
      `${path} на ширине ${width}: серьёзные замечания axe`,
    ).toEqual([]);
  }
}

/** Опубликованная идея с выбором месяца в архиве: страницы идеи и отбора с содержимым. */
async function publishedNumber(): Promise<number> {
  const [idea] = await dbRows<{ number: string }>(`select number from hdi_ideas where status in ('open', 'selected', 'in_development', 'released') and published_on is not null order by number desc limit 1`);
  if (idea) return Number(idea.number);
  const [author] = await dbRows<{ org_id: string; user_id: string; name: string }>(
    `select m.org_id, m.user_id, u.name from hdu_memberships m join auth."user" u on u.id = m.user_id where m.state = 'active' order by m.created_on limit 1`,
  );
  const [row] = await dbRows<{ idea_id: string; number: string }>(
    `insert into hdi_ideas (org_id, author_id, author_name, original_locale, status, published_on) values ($1, $2, $3, 'ru', 'open', now()) returning idea_id, number`,
    [author!.org_id, author!.user_id, author!.name],
  );
  await dbRows(`insert into hdi_idea_translations (idea_id, locale, title, body, source_hash) values ($1, 'ru', 'Проверка доступности идеи', 'Описание идеи', repeat('a', 64))`, [row!.idea_id]);
  return Number(row!.number);
}

test('страницы идей клиента: axe без серьёзных замечаний и без горизонтальной прокрутки на 360, 768 и 1280', async ({ browser }) => {
  test.setTimeout(120_000);
  const number = await publishedNumber();
  const context = await browser.newContext({ storageState: CLIENT_STATE });
  const page = await context.newPage();
  await check(page, '/ru/ideas', (p) => expect(p.getByRole('heading', { level: 1 })).toHaveText('Идеи'));
  await check(page, '/ru/ideas/new', (p) => expect(p.locator('form[data-ready]')).toBeVisible());
  await check(page, `/ru/ideas/${number}`, (p) => expect(p.getByTestId('idea-page')).toBeVisible());
  await check(page, '/ru/ideas/cycles', (p) => expect(p.getByRole('heading', { level: 1 })).toHaveText('Отбор месяца'));
  await context.close();
});

test('страницы идей сотрудника: axe без серьёзных замечаний и без горизонтальной прокрутки на 360, 768 и 1280', async ({ browser }) => {
  test.setTimeout(120_000);
  const number = await publishedNumber();
  const context = await browser.newContext({ storageState: storageStateOf('admin') });
  const page = await context.newPage();
  await check(page, '/ru/agent/ideas?tab=all', (p) => expect(p.getByRole('heading', { level: 1 })).toHaveText('Идеи'));
  await check(page, `/ru/agent/ideas/${number}`, (p) => expect(p.getByTestId('agent-idea')).toBeVisible());
  await check(page, '/ru/agent/ideas/cycles', (p) => expect(p.getByTestId('agent-cycles')).toBeVisible());
  await context.close();
});

test('сценарий 8: страницы идей на узбекском и английском без имён ключей вместо текста', async ({ browser }) => {
  const number = await publishedNumber();
  const client = await browser.newContext({ storageState: CLIENT_STATE });
  const page = await client.newPage();
  for (const locale of ['uz', 'en']) {
    for (const path of ['/ideas', '/ideas/new', `/ideas/${number}`, '/ideas/cycles']) {
      await page.goto(`/${locale}${path}`);
      await expect(page.locator('html')).toHaveAttribute('lang', locale);
      await expect(page.locator('body')).not.toContainText(/\b(common|client|agent)\.[a-z]+\./);
    }
  }
  await client.close();
  const staff = await browser.newContext({ storageState: storageStateOf('admin') });
  const s = await staff.newPage();
  for (const locale of ['uz', 'en']) {
    for (const path of ['/agent/ideas', `/agent/ideas/${number}`, '/agent/ideas/cycles']) {
      await s.goto(`/${locale}${path}`);
      await expect(s.locator('body')).not.toContainText(/\b(common|client|agent)\.[a-z]+\./);
    }
  }
  await staff.close();
});
