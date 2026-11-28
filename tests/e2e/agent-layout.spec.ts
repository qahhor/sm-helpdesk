import { expect, test } from '@playwright/test';
import { dbRows } from './helpers/db';
import { storageStateOf } from './helpers/staff';
import { createClientTicket } from './helpers/tickets';

// Раскладка рабочего места на ширине ноутбука (проверка интерфейса, U1; раздел 8.4 ТЗ): у страницы обращения
// сведения стоят правой колонкой, у очередей список очередей стоит слева, сводка показателей идёт в четыре колонки.
// Раньше классы lg: и sm: не давали CSS, и всё складывалось в одну колонку.

test.beforeEach(({}, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'раскладка ноутбука проверяется на 1280');
});

test.use({ storageState: storageStateOf('admin') });

test('страница обращения: сведения справа от переписки', async ({ page, browser }) => {
  const number = await createClientTicket(browser);
  await page.goto(`/ru/agent/tickets/SUP-${number}`);
  const aside = page.getByRole('complementary', { name: 'Сведения об обращении' });
  await expect(aside).toBeVisible();
  const asideBox = (await aside.boundingBox())!;
  const mainBox = (await page.locator('main').boundingBox())!;
  // Колонка сведений занимает правую треть и начинается на высоте переписки, а не под ней.
  expect(asideBox.x).toBeGreaterThan(mainBox.x + mainBox.width / 2);
  expect(asideBox.width).toBeLessThan(mainBox.width / 2);
});

test('очереди: список очередей слева от таблицы', async ({ page }) => {
  await page.goto('/ru/agent/queues');
  const nav = page.getByRole('navigation', { name: 'Очереди' });
  const search = page.getByRole('search').first();
  await expect(nav).toBeVisible();
  const navBox = (await nav.boundingBox())!;
  const searchBox = (await search.boundingBox())!;
  expect(navBox.x + navBox.width).toBeLessThanOrEqual(searchBox.x);
  expect(Math.abs(navBox.y - searchBox.y)).toBeLessThan(40);
});

test('показатели: сводка в четыре колонки', async ({ page }) => {
  await page.goto('/ru/agent/metrics');
  const cells = page.locator('section[aria-labelledby="metrics-overview"] dl > *');
  await expect(cells.first()).toBeVisible();
  const tops = await cells.evaluateAll((els) => els.slice(0, 4).map((el) => Math.round(el.getBoundingClientRect().top)));
  expect(tops).toHaveLength(4);
  expect(new Set(tops).size).toBe(1);
});

test('карточка организации на 768: страница не прокручивается вбок, таблица участников прокручивается внутри карточки', async ({ page }) => {
  // Проверка интерфейса, U9: скрытая подпись столбца действий стояла вне области прокрутки таблицы и растягивала страницу.
  const [org] = await dbRows<{ org_id: string }>(`select org_id from hdu_organizations where name = 'ACME Trade' limit 1`);
  expect(org).toBeTruthy();
  await page.setViewportSize({ width: 768, height: 800 });
  await page.goto(`/ru/agent/organizations/${org!.org_id}`);
  await expect(page.getByTestId('org-members')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(1);
});

// Проверка интерфейса, второй проход (F2): строка приоритета в настройках сроков шла в пять колонок с 600 px, и в
// поле срока была видна одна цифра, а единица срока (минуты или рабочие дни) не читалась ни на одной ширине.
test('настройки сроков: число и единица срока читаются целиком на 600, 768, 1024 и 1280', async ({ page }) => {
  for (const width of [600, 768, 1024, 1280]) {
    await page.setViewportSize({ width, height: 800 });
    await page.goto('/ru/agent/settings/sla');
    await expect(page.locator('#res-p1')).toBeVisible();
    const cramped = await page.evaluate(() => {
      const canvas = document.createElement('canvas').getContext('2d')!;
      /** Сколько места остаётся в поле числа после текста: отступы и кнопки числа вычтены. */
      const room = (el: HTMLElement, text: string) => {
        const style = getComputedStyle(el);
        canvas.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
        const spinner = 24;
        return el.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight) - spinner - canvas.measureText(text).width;
      };
      /** Ширина, которую браузер сам отводит списку под самую длинную подпись и стрелку. */
      const natural = (select: HTMLSelectElement) => {
        const copy = select.cloneNode(true) as HTMLSelectElement;
        copy.style.cssText = 'position:absolute;visibility:hidden;width:max-content;min-width:0;flex:none';
        select.parentElement!.append(copy);
        const width = copy.offsetWidth;
        copy.remove();
        return width;
      };
      const out: string[] = [];
      for (const form of document.querySelectorAll<HTMLFormElement>('section[aria-labelledby="sla-policies"] form')) {
        const priority = form.querySelector<HTMLInputElement>('input[name="priority"]')!.value;
        for (const select of form.querySelectorAll('select'))
          if (select.offsetWidth < natural(select)) out.push(`${priority} ${select.name}: ${select.offsetWidth} px из ${natural(select)}`);
        // Пять цифр: срок в минутах до нескольких недель.
        for (const input of form.querySelectorAll<HTMLInputElement>('input[type="number"]'))
          if (room(input, '00000') < 0) out.push(`${priority} ${input.name}: пять цифр в ${input.clientWidth} px`);
      }
      return out;
    });
    expect(cramped, `ширина ${width}`).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), `ширина ${width}`).toBe(true);
  }
});
