import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, test } from '@playwright/test';
import { EICAR } from '../helpers/fake-clamd';
import { CLIENT_STATE, signInAsCustom, uniqueSub } from './helpers/client';
import { dbRows } from './helpers/db';

// Обращения клиента (сценарий S2, FR-TK-01 - FR-TK-17, UX-C-02, UX-C-05, UX-C-11, UX-C-12; план M2, задача 9).
// Клиент Алишер (ACME Trade) из сохранённой сессии. Файлы проверяет фоновый процесс с заглушкой антивируса.
test.use({ storageState: CLIENT_STATE });

// Сессия Алишера общая для всех тестов, проектов и прогонов, а обращений не больше 10 в час на человека (раздел 14.5):
// счётчики обращений, ответов и загрузок в базе браузерных тестов сбрасываются прямо перед каждой отправкой.
const resetLimits = () =>
  dbRows(`delete from hdc_rate_limits where code like 'ticket-create:user:%' or code like 'ticket-reply:user:%' or code like 'upload-presign:user:%'`);
test.beforeEach(resetLimits);

// Настоящая картинка PNG 1x1: фоновый процесс сверяет тип по содержимому.
const PNG = Buffer.from(
  '89504e470d0a1a0a0000000d4948445200000001000000010806000000' + '1f15c4890000000d49444154789c6360f8cfc0f01f0005000201e5270ba20000000049454e44ae426082',
  'hex',
);

/** Новый контекст без сессии: иначе он наследует сохранённую сессию Алишера из test.use. */
const SIGNED_OUT = { storageState: { cookies: [], origins: [] } };

type NewTicket = { description: string; visibility?: 'Моя организация' | 'Только я'; file?: { name: string; mimeType: string; buffer: Buffer } };

/** Обращение через форму, как его создаёт клиент. Возвращает номер. */
/** Форма готова к вводу: черновик подставлен после гидратации. */
const formReady = (page: Page) => expect(page.locator('form[data-ready]').first()).toBeAttached();

async function createTicket(page: Page, ticket: NewTicket): Promise<number> {
  await page.goto('/ru/tickets/new');
  await formReady(page);
  await page.getByLabel('Что случилось?').fill(ticket.description);
  await page.getByRole('radio', { name: 'Ошибка' }).check();
  await page.getByLabel('Влияние на работу').selectOption({ label: 'Серьёзно мешает' });
  await page.getByRole('radio', { name: ticket.visibility ?? 'Моя организация' }).check();
  if (ticket.file) {
    await page.locator('input[type="file"]').setInputFiles(ticket.file);
    await expect(page.getByText('Загружен', { exact: true })).toBeVisible();
  }
  await resetLimits();
  await page.getByRole('button', { name: 'Отправить обращение' }).click();
  await expect(page).toHaveURL(/\/ru\/tickets\/SUP-\d+(\?created=1)?$/);
  return Number(/SUP-(\d+)/.exec(page.url())?.[1]);
}

/** Перезагружает страницу, пока на ней не появится текст: файл проверяет фоновый процесс. */
async function reloadUntil(page: Page, text: string | RegExp): Promise<void> {
  await expect
    .poll(
      async () => {
        await page.reload();
        return page.getByText(text).count();
      },
      { timeout: 30_000, intervals: [500, 1000, 2000] },
    )
    .toBeGreaterThan(0);
}

test('S2: вход, "Сообщить о проблеме", тип, влияние, видимость, скриншот, отправка, страница SUP-xxxx со статусом "Новое"', async ({ page }) => {
  await page.goto('/ru');
  await page.getByRole('link', { name: 'Сообщить о проблеме' }).click();
  await expect(page).toHaveURL(/\/ru\/tickets\/new$/);
  await formReady(page);
  const description = `Не грузится отчёт по продажам ${Date.now()}. Крутится загрузка.`;
  await page.getByLabel('Что случилось?').fill(description);
  // Тема подставлена из описания и её можно поправить.
  await expect(page.getByLabel('Тема обращения')).toHaveValue(description.split('.')[0] ?? '');
  await page.getByRole('radio', { name: 'Ошибка' }).check();
  await page.getByLabel('Влияние на работу').selectOption({ label: 'Серьёзно мешает' });
  await page.getByRole('radio', { name: 'Моя организация' }).check();
  await page.locator('input[type="file"]').setInputFiles({ name: 'screenshot.png', mimeType: 'image/png', buffer: PNG });
  await expect(page.getByText('Загружен', { exact: true })).toBeVisible();
  // Миниатюра до отправки загрузилась (политика CSP пропускает blob:).
  const preview = page.locator('[data-upload="ready"] img');
  await expect(preview).toBeVisible();
  expect(await preview.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBeGreaterThan(0);
  await resetLimits();
  await page.getByRole('button', { name: 'Отправить обращение' }).click();
  await expect(page).toHaveURL(/\/ru\/tickets\/SUP-\d+(\?created=1)?$/);
  const number = /SUP-\d+/.exec(page.url())?.[0] ?? '';
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(description.split('.')[0] ?? '');
  await expect(page.getByText(number, { exact: true })).toBeVisible();
  await expect(page.getByText('Новое', { exact: true })).toBeVisible();
  await expect(page.getByText('Ход поддержки')).toBeVisible();
  await expect(page.getByRole('list', { name: 'Ход обращения' }).locator('[aria-current="step"]')).toContainText('Создано');
  // После проверки скриншот виден миниатюрой и скачивается.
  await reloadUntil(page, /^screenshot\.png$/);
  await expect(page.getByRole('link', { name: /screenshot\.png/ })).toHaveAttribute('href', /^\/api\/attachments\//);
  await expect(page.getByRole('img', { name: 'screenshot.png' })).toBeVisible();
  // Обращение находится в списке по номеру. На главной не больше трёх последних (другие тесты тоже создают обращения).
  await page.goto(`/ru/tickets?q=${number}`);
  await expect(page.getByRole('link', { name: new RegExp(number) })).toBeVisible();
  await page.goto('/ru');
  const recent = page.getByRole('link', { name: /^SUP-\d+/ });
  await expect(recent.first()).toBeVisible();
  expect(await recent.count()).toBeLessThanOrEqual(3);
});

test('черновик после перезагрузки на месте (UX-C-02)', async ({ page }) => {
  await page.goto('/ru/tickets/new');
  await formReady(page);
  const text = `Черновик ${Date.now()}`;
  await page.getByLabel('Что случилось?').fill(text);
  await page.getByRole('radio', { name: 'Только я' }).check();
  await page.reload();
  await expect(page.getByLabel('Что случилось?')).toHaveValue(text);
  await expect(page.getByRole('radio', { name: 'Только я' })).toBeChecked();
  // Обрыв сети при отправке (FR-TK-16): после перезагрузки текст на месте.
  await formReady(page);
  await page.route('**/ru/tickets/new', (route) => (route.request().method() === 'POST' ? route.abort() : route.continue()));
  await page.getByRole('button', { name: 'Отправить обращение' }).click();
  await page.waitForTimeout(500);
  await page.unroute('**/ru/tickets/new');
  await page.reload();
  await formReady(page);
  await expect(page.getByLabel('Что случилось?')).toHaveValue(text);
  // Черновик ответа тоже на месте. Отправленное обращение черновик убирает.
  const number = await createTicket(page, { description: `Для черновика ответа ${Date.now()}` });
  await page.goto('/ru/tickets/new');
  await formReady(page);
  await expect(page.getByLabel('Что случилось?')).toHaveValue('');
  await page.goto(`/ru/tickets/SUP-${number}`);
  await formReady(page);
  await page.getByLabel('Ответ').fill('Ответ, который не успел уйти');
  await page.reload();
  await expect(page.getByLabel('Ответ')).toHaveValue('Ответ, который не успел уйти');
  // После отправки черновик пропадает.
  await resetLimits();
  await page.getByRole('button', { name: 'Отправить', exact: true }).click();
  await expect(page.getByText('Ответ отправлен')).toBeVisible();
  // Отметка успеха убрана из адреса: перезагрузка не тронет следующий черновик.
  await expect(page).toHaveURL(new RegExp(`/ru/tickets/SUP-${number}$`));
  await expect(page.getByText('Ответ, который не успел уйти')).toBeVisible();
  await expect(page.getByLabel('Ответ')).toHaveValue('');
  // Следующий черновик после перезагрузки на месте.
  await formReady(page);
  await page.getByLabel('Ответ').fill('Следующий ответ');
  await page.reload();
  await formReady(page);
  await expect(page.getByLabel('Ответ')).toHaveValue('Следующий ответ');
});

test('EICAR: файл помечен "не прошёл проверку", ссылки на скачивание нет, прямой адрес отвечает 404', async ({ page }) => {
  const name = `readme-${Date.now()}.txt`;
  await createTicket(page, { description: `Файл с тестовой строкой ${Date.now()}`, file: { name, mimeType: 'text/plain', buffer: Buffer.from(EICAR) } });
  await reloadUntil(page, 'не прошёл проверку');
  await expect(page.getByRole('link', { name: new RegExp(name) })).toHaveCount(0);
  const [row] = await dbRows<{ attachment_id: string; scan_status: string }>(`select attachment_id, scan_status from hdt_attachments where file_name = $1`, [name]);
  expect(row?.scan_status).toBe('infected');
  const response = await page.request.get(`/api/attachments/${row?.attachment_id}`, { maxRedirects: 0 });
  expect(response.status()).toBe(404);
});

test('ссылка на номер у коллеги открывается, у пользователя другой организации "не найдено" (на что смотреть, 5)', async ({ page, browser }) => {
  // Три входа через ложный сервер Smartup.
  test.setTimeout(120_000);
  const description = `Обращение для коллеги ${Date.now()}`;
  const number = await createTicket(page, { description });
  const path = `/ru/tickets/SUP-${number}`;
  const colleague = await browser.newContext(SIGNED_OUT);
  try {
    const p = await colleague.newPage();
    await signInAsCustom(p, { sub: uniqueSub(), name: 'Коллега', company_id: '501', company_name: 'ACME Trade' });
    await p.goto(path);
    await expect(p.getByRole('heading', { level: 1 })).toHaveText(description);
  } finally {
    await colleague.close();
  }
  const stranger = await browser.newContext(SIGNED_OUT);
  try {
    const p = await stranger.newPage();
    await signInAsCustom(p, { sub: uniqueSub(), name: 'Чужой', company_id: '502', company_name: 'Globex' });
    await p.goto(path);
    await expect(p.getByRole('heading', { name: 'Страница не найдена' })).toBeVisible();
    await expect(p.getByText(description)).toHaveCount(0);
  } finally {
    await stranger.close();
  }
  // Без входа ссылка ведёт на вход с возвратом на обращение.
  const anonymous = await browser.newContext(SIGNED_OUT);
  try {
    const p = await anonymous.newPage();
    await p.goto(path);
    await expect(p).toHaveURL(new RegExp(`/ru/login\\?next=%2Fru%2Ftickets%2FSUP-${number}$`));
  } finally {
    await anonymous.close();
  }
});

test('ссылка на обращение другой своей организации предлагает переключиться и открывает его (UX-C-06)', async ({ browser }) => {
  test.setTimeout(120_000);
  // Автор из Globex создаёт обращение организации.
  const authorContext = await browser.newContext(SIGNED_OUT);
  const description = `Обращение Globex ${Date.now()}`;
  let number: number;
  try {
    const author = await authorContext.newPage();
    await signInAsCustom(author, { sub: uniqueSub(), name: 'Автор Globex', company_id: '502', company_name: 'Globex' });
    number = await createTicket(author, { description });
  } finally {
    await authorContext.close();
  }
  // Участник обеих организаций, сейчас вошёл в ACME Trade.
  const sub = uniqueSub();
  const name = `Двойной ${sub}`;
  const context = await browser.newContext(SIGNED_OUT);
  try {
    const page = await context.newPage();
    await signInAsCustom(page, { sub, name, company_id: '501', company_name: 'ACME Trade' });
    const [user] = await dbRows<{ id: string }>(`select id from auth."user" where name = $1`, [name]);
    const [ticket] = await dbRows<{ org_id: string }>(`select org_id from hdt_tickets where number = $1`, [number]);
    await dbRows(`insert into hdu_memberships (org_id, user_id, role, source) values ($1, $2, 'client_user', 'invite')`, [ticket?.org_id, user?.id]);
    await page.goto(`/ru/tickets/SUP-${number}`);
    await expect(page.getByText(`Обращение SUP-${number} относится к организации Globex`)).toBeVisible();
    await expect(page.getByText(description)).toHaveCount(0);
    await page.getByRole('button', { name: 'Перейти в Globex' }).click();
    await expect(page).toHaveURL(new RegExp(`/ru/tickets/SUP-${number}$`));
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(description);
    await expect(page.getByRole('banner')).toContainText('Globex');
  } finally {
    await context.close();
  }
});

test('страницы обращений без серьёзных нарушений доступности, без прокрутки вбок на 360 px, масштаб 200% (UX-C-12)', async ({ page }) => {
  test.setTimeout(90_000);
  const number = await createTicket(page, { description: `Проверка доступности ${Date.now()}. Длинный текст без пробелов: ${'х'.repeat(120)}` });
  const paths = ['/ru/tickets', '/ru/tickets/new', `/ru/tickets/SUP-${number}`, '/uz/tickets/new', `/en/tickets/SUP-${number}`];
  for (const path of paths) {
    await page.goto(path);
    const { violations } = await new AxeBuilder({ page }).analyze();
    expect(violations.filter((v) => ['serious', 'critical'].includes(v.impact ?? '')).map((v) => `${path} ${v.id}`)).toEqual([]);
  }
  // Телефон 360 px и масштаб 200% на ширине 1280 px (640 px CSS): без прокрутки вбок.
  for (const width of [360, 640]) {
    await page.setViewportSize({ width, height: 740 });
    for (const path of paths) {
      await page.goto(path);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), `${width} ${path}`).toBe(true);
    }
  }
  // Увеличенный системный шрифт на компьютере: корневой размер вдвое больше, вёрстка не уезжает вбок.
  await page.setViewportSize({ width: 1280, height: 800 });
  for (const path of paths) {
    await page.goto(path);
    // Через CSSOM, а не тегом style: политика CSP не пропускает встроенные стили без одноразового кода.
    await page.evaluate(() => document.documentElement.style.setProperty('font-size', '200%'));
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), `шрифт ${path}`).toBe(true);
  }
});
