import { expect, test } from '@playwright/test';
import { dbRows } from './helpers/db';
import { storageStateOf } from './helpers/staff';

// Кнопка "Принять перевод" на карточке известной проблемы и на странице объявлений (план M5c, решения 17 и 24; долг
// задач 2 и 6, закрыт задачей 11): машинный перевод клиенту не виден, пока сотрудник его не принял; принятие ставит
// отметку принятия в базе. Машинный перевод вставляется в базу напрямую: модель в браузерных тестах не нужна.

test.beforeEach(({}, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'кнопка одна на всех ширинах');
});
test.describe.configure({ mode: 'serial' });

test('карточка проблемы: машинный перевод принимается кнопкой', async ({ browser }) => {
  const context = await browser.newContext({ storageState: storageStateOf('l2') });
  const page = await context.newPage();
  const stamp = Date.now();
  const [problem] = await dbRows<{ problem_id: string; number: number }>(`insert into hdp_problems (internal_title, source_locale) values ($1, 'ru') returning problem_id, number`, [`Перевод ${stamp}`]);
  await dbRows(`insert into hdp_problem_translations (problem_id, locale, public_title, public_body) values ($1, 'ru', 'Не проводятся накладные', 'Исправляем.')`, [problem!.problem_id]);
  await dbRows(`insert into hdp_problem_translations (problem_id, locale, public_title, public_body, is_machine) values ($1, 'uz', 'Yuk xatlari o''tkazilmaydi', 'Tuzatyapmiz.', true)`, [problem!.problem_id]);
  await page.goto(`/ru/agent/problems/${problem!.number}`);
  const uz = page.getByRole('main').locator('[data-locale="uz"]');
  await expect(uz.getByText('Клиенту не виден, пока перевод не принят')).toBeVisible();
  await uz.getByRole('button', { name: 'Принять перевод' }).click();
  await expect(page.getByRole('main').locator('[data-locale="uz"]').getByText('Перевод принят')).toBeVisible();
  const [row] = await dbRows<{ accepted: boolean }>(`select accepted_by is not null as accepted from hdp_problem_translations where problem_id = $1 and locale = 'uz'`, [problem!.problem_id]);
  expect(row!.accepted).toBe(true);
  await context.close();
});

test('объявления: машинный перевод принимается кнопкой', async ({ browser }) => {
  const context = await browser.newContext({ storageState: storageStateOf('care') });
  const page = await context.newPage();
  // Метка из букв: длинное число в тексте объявления - находка проверки текста.
  const stamp = Array.from({ length: 7 }, () => 'bdfghjklmnprstvz'[Math.floor(Math.random() * 16)]).join('');
  const [ann] = await dbRows<{ announcement_id: string }>(
    `insert into hdp_announcements (kind, audience, starts_on, ends_on, source_locale, author_id) values ('news', 'all', now() + interval '1 day', now() + interval '2 days', 'ru', (select id from auth."user" order by "createdAt" limit 1)) returning announcement_id`,
  );
  await dbRows(`insert into hdp_announcement_translations (announcement_id, locale, title, body) values ($1, 'ru', $2, 'Текст')`, [ann!.announcement_id, `Новость ${stamp}`]);
  await dbRows(`insert into hdp_announcement_translations (announcement_id, locale, title, body, is_machine) values ($1, 'uz', $2, 'Matn', true)`, [ann!.announcement_id, `Yangilik ${stamp}`]);
  await page.goto('/ru/agent/announcements');
  const form = page.locator('form[lang="uz"]').filter({ has: page.locator(`input[value="${ann!.announcement_id}"]`) });
  await form.getByRole('button', { name: 'Принять перевод' }).click();
  await expect(page.locator('form[lang="uz"]').filter({ has: page.locator(`input[value="${ann!.announcement_id}"]`) }).getByText('Перевод принят')).toBeVisible();
  const [row] = await dbRows<{ accepted: boolean }>(`select accepted_by is not null as accepted from hdp_announcement_translations where announcement_id = $1 and locale = 'uz'`, [ann!.announcement_id]);
  expect(row!.accepted).toBe(true);
  await context.close();
});
