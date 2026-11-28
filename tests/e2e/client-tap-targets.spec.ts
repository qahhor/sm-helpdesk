import { expect, type Page, test } from '@playwright/test';
import { CLIENT_STATE } from './helpers/client';
import { createClientTicket } from './helpers/tickets';

// Цели нажатия в кабинете клиента на телефоне не меньше 44 px (ТЗ 8.1, пункт 8; проверка интерфейса, U11). Проверяются
// все видимые ссылки, кнопки и поля страницы. Ссылка внутри строки текста не считается: её область задаёт строка.
// Флажок и переключатель меряются вместе с подписью.

test.beforeEach(({}, testInfo) => {
  test.skip(testInfo.project.name !== 'phone', 'цели нажатия меряются на телефоне');
});

const MIN = 44;

/** Видимые цели нажатия меньше 44 px по высоте или ширине: "тег[подпись] ШxВ". */
function smallTargets(page: Page): Promise<string[]> {
  return page.evaluate((min) => {
    const visible = (el: Element) => {
      const r = el.getBoundingClientRect();
      const s = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none' && Number(s.opacity) > 0;
    };
    const found: string[] = [];
    for (const el of Array.from(document.querySelectorAll('a[href],button,input:not([type=hidden]),select,textarea,[role=button],[role=tab],[role=menuitem],summary'))) {
      if (!visible(el) || el.classList.contains('sr-only')) continue;
      let rect = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      const ownText = (el.textContent ?? '').trim();
      if (el.tagName === 'A' && style.display === 'inline' && (el.parentElement?.textContent ?? '').trim().length > ownText.length + 10) continue;
      if (el instanceof HTMLInputElement && ['checkbox', 'radio', 'file'].includes(el.type)) {
        const label = el.closest('label') ?? (el.id ? document.querySelector(`label[for="${el.id}"]`) : null);
        if (label) rect = label.getBoundingClientRect();
      }
      if (rect.width <= 1) continue;
      if (rect.height < min - 0.5 || rect.width < min - 0.5)
        found.push(`${el.tagName.toLowerCase()}[${(el.getAttribute('aria-label') ?? ownText).replace(/\s+/g, ' ').slice(0, 40)}] ${Math.round(rect.width)}x${Math.round(rect.height)}`);
    }
    return found;
  }, MIN);
}

test.describe('клиент', () => {
  test.use({ storageState: CLIENT_STATE });

  test('страницы кабинета: цели нажатия не меньше 44 px', async ({ page, browser }) => {
    const number = await createClientTicket(browser);
    const problems: Record<string, string[]> = {};
    for (const path of ['/ru', '/ru/tickets', '/ru/tickets/new', `/ru/tickets/SUP-${number}`, '/ru/ideas', '/ru/ideas/new', '/ru/ideas/cycles', '/ru/problems', '/ru/announcements', '/ru/notifications', '/ru/settings']) {
      await page.goto(path);
      await expect(page.getByRole('main')).toBeVisible();
      await page.waitForLoadState('networkidle');
      const small = await smallTargets(page);
      if (small.length > 0) problems[path] = small;
    }
    expect(problems).toEqual({});
  });
});

test('страницы входа: цели нажатия не меньше 44 px', async ({ page }) => {
  const problems: Record<string, string[]> = {};
  for (const path of ['/ru/login', '/ru/staff/login']) {
    await page.goto(path);
    await expect(page.getByRole('main')).toBeVisible();
    const small = await smallTargets(page);
    if (small.length > 0) problems[path] = small;
  }
  expect(problems).toEqual({});
});
