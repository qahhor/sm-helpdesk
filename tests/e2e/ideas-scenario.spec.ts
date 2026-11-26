import { execFileSync } from 'node:child_process';
import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, test } from '@playwright/test';
import { CLIENT_STATE, signInAsCustom, uniqueSub } from './helpers/client';
import { dbRows } from './helpers/db';
import { storageStateOf } from './helpers/staff';

// Сквозной сценарий 7 ТЗ (15.3; план M7, задача 10): клиент А подаёт идею и видит похожую, клиент Б не видит её на
// модерации, модератор публикует, А и Б голосуют, повторный голос А ничего не меняет, отбор месяца запускается
// командой hub с подменой времени (--month), сотрудник выбирает не лидера с объяснением и машинным черновиком, оба
// клиента получают уведомление, идея уходит в разработку и доходит до "Выпущена".
//
// Отбор месяца общий для всей базы браузерных тестов, поэтому сценарий идёт только на ноутбуке, а месяц берётся
// следующий за последним отбором в базе (не раньше 2100 года): повторный прогон не упирается в уже сделанный отбор.
// После сценария его отборы (с 2100 года) и идеи (заголовок "Сценарий 7:") удаляются: иначе главная страница
// показывала бы идею сценария выбранной навсегда (итоговая проверка M7, пункт M5). Чужие идеи сценарий не трогает:
// перед отбором его идеи получают голосов больше, чем у любой другой открытой идеи базы, поэтому пятёрка не зависит
// от идей других тестов.

const SCENARIO_TITLE = 'Сценарий 7:%';
const SCENARIO_CYCLES = '2100-01-01';
/** Пометка машинного текста на узбекском (client.ideas.machine). */
const UZ_MACHINE = 'Mashina tarjimasi';

test.beforeEach(({}, info) => {
  test.skip(info.project.name !== 'desktop', 'отбор месяца общий для базы: сценарий идёт в одном проекте');
});

/** Удаляет отборы и идеи сценария со всеми их строками. Вызывается до сценария (остатки прерванного прогона) и после. */
async function cleanupScenario(): Promise<void> {
  await dbRows(`delete from hdi_cycles where cycle >= $1`, [SCENARIO_CYCLES]);
  const ids = (await dbRows<{ idea_id: string }>(`select distinct idea_id from hdi_idea_translations where title like $1`, [SCENARIO_TITLE])).map((r) => r.idea_id);
  if (ids.length === 0) return;
  const tasks = (await dbRows<{ dev_task_id: string }>(`delete from hdw_dev_task_links where idea_id = any ($1) returning dev_task_id`, [ids])).map((r) => r.dev_task_id);
  await dbRows(`delete from hdw_dev_tasks t where t.dev_task_id = any ($1) and not exists (select 1 from hdw_dev_task_links l where l.dev_task_id = t.dev_task_id)`, [tasks]);
  await dbRows(`delete from hdn_outbox where payload ->> 'ideaId' = any ($1)`, [ids]);
  await dbRows(`delete from hdk_search_documents where kind = 'idea' and ref_id = any ($1)`, [ids]);
  for (const table of ['hdi_votes', 'hdi_subscriptions', 'hdi_comments', 'hdi_attachments', 'hdi_idea_translations']) await dbRows(`delete from ${table} where idea_id = any ($1)`, [ids]);
  // Колокольчик удаляется вместе с идеей (hdn_notifications_f2 ON DELETE CASCADE).
  await dbRows(`delete from hdi_ideas where idea_id = any ($1)`, [ids]);
}

test.afterAll(async ({}, info) => {
  if (info.project.name === 'desktop') await cleanupScenario();
});

const tag = () =>
  Array.from({ length: 7 }, () => 'бвгджзклмнпрстфхцчшщ'[Math.floor(Math.random() * 20)])
    .join('')
    .replace(/^./, (c) => c.toUpperCase());

const serious = async (page: Page) =>
  (await new AxeBuilder({ page }).analyze()).violations.filter((v) => ['serious', 'critical'].includes(v.impact ?? '')).map((v) => v.id);

/** Следующий месяц после последнего отбора в базе, не раньше 2100-01: в формате ГГГГ-ММ для hub ideas:cycle. */
async function nextCycleMonth(): Promise<string> {
  const [row] = await dbRows<{ last: string | null }>(`select max(cycle)::text as last from hdi_cycles`);
  const last = row?.last && row.last >= '2100-01-01' ? row.last : '2099-12-01';
  const [y, m] = last.split('-').map(Number) as [number, number];
  const next = m === 12 ? { y: y + 1, m: 1 } : { y, m: m + 1 };
  return `${next.y}-${String(next.m).padStart(2, '0')}`;
}

/** Лидер отбора: опубликованная идея организации А с четырьмя голосами клиентов, в индексе похожих. */
/** Новые клиенты организации: голосующие сценария. */
async function newVoters(orgId: string, count: number): Promise<{ user_id: string; name: string }[]> {
  return dbRows<{ user_id: string; name: string }>(
    `with u as (insert into auth."user" (name, email, "emailVerified") select 'Сценарий 7, голос ' || g, 'scenario7-' || g || '-' || $2 || '@acme.example', true from generate_series(1, $3::int) g returning id, name)
     , m as (insert into hdu_memberships (org_id, user_id, role, source) select $1, id, 'client_user', 'invite' from u returning user_id)
     select m.user_id, u.name from m join u on u.id = m.user_id`,
    [orgId, uniqueSub(), count],
  );
}

/** Голоса новых клиентов за опубликованную идею (строки под суперпользователем, триггеры пересчёта работают). */
async function addVotes(ideaId: string, orgId: string, count: number): Promise<void> {
  if (count <= 0) return;
  for (const user of await newVoters(orgId, count)) await dbRows(`insert into hdi_votes (org_id, idea_id, user_id) values ($1, $2, $3)`, [orgId, ideaId, user.user_id]);
}

async function leaderIdea(word: string, orgId: string): Promise<{ ideaId: string; number: number; title: string }> {
  const users = await newVoters(orgId, 4);
  const title = `Сценарий 7: ${word} печать накладных пачкой`;
  const body = 'Печатать все накладные дня одной кнопкой';
  const [idea] = await dbRows<{ idea_id: string; number: string }>(
    `insert into hdi_ideas (org_id, author_id, author_name, original_locale, status, published_on) values ($1, $2, $3, 'ru', 'open', now()) returning idea_id, number`,
    [orgId, users[0]!.user_id, users[0]!.name],
  );
  await dbRows(`insert into hdi_idea_translations (idea_id, locale, title, body, source_hash) values ($1, 'ru', $2, $3, repeat('a', 64))`, [idea!.idea_id, title, body]);
  await dbRows(`insert into hdk_search_documents (ref_id, kind, locale, title, body_text, audience) values ($1, 'idea', 'ru', $2, $3, 'clients')`, [idea!.idea_id, title, body]);
  for (const user of users) await dbRows(`insert into hdi_votes (org_id, idea_id, user_id) values ($1, $2, $3)`, [orgId, idea!.idea_id, user.user_id]);
  return { ideaId: idea!.idea_id, number: Number(idea!.number), title };
}

test('сценарий 7: подача, модерация, голоса двух клиентов, отбор месяца, выбор не лидера, разработка, "Выпущена"', async ({ browser }) => {
  test.setTimeout(180_000);
  // Остатки прерванного прогона: идеи и отборы сценария.
  await cleanupScenario();
  const word = tag();
  const clientA = await browser.newContext({ storageState: CLIENT_STATE });
  const a = await clientA.newPage();
  const [acme] = await dbRows<{ org_id: string }>(`select org_id from hdu_organizations where name = 'ACME Trade' limit 1`);
  const leader = await leaderIdea(word, acme!.org_id);

  // 1. Клиент А печатает заголовок, видит похожую идею (лидера) и всё же подаёт свою.
  await a.goto('/ru/ideas/new');
  await expect(a.locator('form[data-ready]')).toBeVisible();
  await a.getByLabel('Заголовок').fill(`Сценарий 7: ${word} печать накладных по складам`);
  const similar = a.getByTestId('similar-ideas').getByRole('listitem').filter({ hasText: word });
  await expect(similar.getByRole('link', { name: leader.title })).toBeVisible({ timeout: 15_000 });
  await a.getByLabel('Описание').fill('Печатать накладные сразу по всем складам, а не по одному');
  await a.getByRole('button', { name: 'Отправить идею' }).click();
  await expect(a.getByRole('heading', { level: 1 })).toHaveText('Идея отправлена на проверку');
  const number = Number(new URL(a.url()).searchParams.get('sent'));
  expect(number).toBeGreaterThan(0);
  const [mine] = await dbRows<{ idea_id: string; author_id: string; status: string }>(`select idea_id, author_id, status from hdi_ideas where number = $1`, [number]);
  expect(mine?.status).toBe('pending_review');

  // 2. Клиент Б другой организации идею на модерации не находит.
  const clientB = await browser.newContext();
  const b = await clientB.newPage();
  await signInAsCustom(b, { sub: uniqueSub(), name: 'Бобур', company_id: uniqueSub(), company_name: `Сценарий Б ${word}` });
  expect((await b.goto(`/ru/ideas/${number}`))?.status()).toBe(404);

  // 3. Модератор (администратор) публикует.
  const staff = await browser.newContext({ storageState: storageStateOf('admin') });
  const s = await staff.newPage();
  await s.goto(`/ru/agent/ideas/${number}`);
  await s.getByRole('button', { name: 'Опубликовать' }).click();
  await expect(s.getByText('Идея опубликована.')).toBeVisible();

  // 4. Голоса: голос автора уже стоит (решение 4), Б голосует; повторный голос из устаревшей вкладки ничего не меняет.
  await b.goto(`/ru/ideas/${number}`);
  await b.getByTestId('vote-button').click();
  await expect(b.getByTestId('vote-button')).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(async () => (await dbRows<{ vote_count: number }>(`select vote_count from hdi_ideas where number = $1`, [number]))[0]?.vote_count).toBe(2);
  await a.goto(`/ru/ideas/${number}`);
  await expect(a.getByTestId('vote-button')).toHaveAttribute('aria-pressed', 'true');
  await a.getByTestId('vote-button').click();
  await expect(a.getByTestId('vote-button')).toHaveAttribute('aria-pressed', 'false');
  const stale = await clientA.newPage();
  await stale.goto(`/ru/ideas/${number}`);
  await expect(stale.getByTestId('vote-button')).toHaveAttribute('aria-pressed', 'false');
  await a.getByTestId('vote-button').click();
  await expect(a.getByTestId('vote-button')).toHaveAttribute('aria-pressed', 'true');
  // Вкладка ещё показывает "не голосовал": второй голос того же человека база не принимает, счётчик тот же.
  await stale.getByTestId('vote-button').click();
  await expect(stale.getByTestId('vote-button')).toHaveAttribute('aria-pressed', 'true');
  await expect(stale.getByTestId('vote-button')).toContainText('2');
  const votes = await dbRows<{ n: number; users: number }>(`select count(*)::int as n, count(distinct user_id)::int as users from hdi_votes where idea_id = $1`, [mine!.idea_id]);
  expect(votes[0]).toEqual({ n: 2, users: 2 });

  // 5. Отбор месяца командой hub с подменой времени: 1-е число выбранного месяца, 09:00 по Ташкенту. Пятёрка не
  // зависит от идей других тестов: идея А и лидер получают голосов больше любой другой открытой идеи базы (с запасом на
  // голоса параллельных тестов), лидер остаётся первым.
  const [others] = await dbRows<{ top: number }>(
    `select coalesce(max(vote_count), 0)::int as top from hdi_ideas where status = 'open' and idea_id <> all ($1)`,
    [[leader.ideaId, mine!.idea_id]],
  );
  const mineVotes = Math.max(2, others!.top + 5);
  await addVotes(mine!.idea_id, acme!.org_id, mineVotes - 2);
  await addVotes(leader.ideaId, acme!.org_id, Math.max(0, mineVotes + 2 - 4));
  const month = await nextCycleMonth();
  const out = execFileSync(process.execPath, ['dist/hub.mjs', 'ideas:cycle', '--month', month], { encoding: 'utf8', env: process.env });
  expect(out).toContain(`Отбор ${month}-01 создан`);
  expect(out).toContain(`I-${leader.number}`);
  expect(out).toContain(`I-${number}`);

  // 6. Сотрудник выбирает не лидера: без объяснения нельзя, черновик перевода машинный, сохраняет сам.
  await s.goto('/ru/agent/ideas/cycles');
  const form = s.getByTestId('cycle-decision');
  await expect(form.getByRole('radio', { name: new RegExp(`I-${leader.number} .*лидер`) })).toBeChecked();
  await form.getByRole('radio', { name: new RegExp(`I-${number} `) }).check();
  await expect(form.getByLabel('Объяснение на русском')).toHaveAttribute('required', '');
  await form.getByLabel('Объяснение на русском').fill(`Печать по складам нужна всем клиентам с филиалами ${word}`);
  await form.getByRole('button', { name: 'Перевести' }).click();
  await expect(form.getByText('Машинный черновик')).toBeVisible();
  await expect(form.getByLabel('Объяснение на английском')).toHaveValue(new RegExp(word));
  await form.getByLabel('Объяснение на английском').fill(`Printing by warehouse helps every client with branches ${word}`);
  expect(await serious(s)).toEqual([]);
  await form.getByRole('button', { name: 'Выбрать идею месяца' }).click();
  await expect(s.getByText('Идея месяца выбрана.')).toBeVisible();
  await expect.poll(async () => (await dbRows<{ status: string }>(`select status from hdi_ideas where number = $1`, [number]))[0]?.status).toBe('selected');
  expect((await dbRows<{ status: string }>(`select status from hdi_ideas where idea_id = $1`, [leader.ideaId]))[0]?.status).toBe('open');

  // 7. Оба клиента получили уведомление "выбрана идеей месяца".
  const voters = await dbRows<{ user_id: string }>(`select user_id from hdi_votes where idea_id = $1`, [mine!.idea_id]);
  const notified = await dbRows<{ user_id: string }>(`select user_id from hdn_notifications where idea_id = $1 and payload ->> 'status' = 'selected'`, [mine!.idea_id]);
  expect(notified.map((n) => n.user_id).sort()).toEqual(voters.map((v) => v.user_id).sort());
  await b.goto('/ru/notifications');
  await expect(b.getByText(`Идея I-${number}: выбрана идеей месяца`)).toBeVisible();

  // 8. Передача в разработку (ручной режим таск-менеджера) и "Выпущена" с версией.
  await s.goto(`/ru/agent/ideas/${number}`);
  const send = s.getByTestId('idea-send-dev');
  await send.getByLabel('Номер задачи').fill(`IDEA-${number}`);
  await send.getByLabel('Ссылка на задачу').fill(`https://tracker.smartup.example/tasks/IDEA-${number}`);
  await send.getByRole('button', { name: 'Передать' }).click();
  await expect(s.getByText('Идея передана в разработку.')).toBeVisible();
  await expect(s.getByTestId('idea-dev-task')).toContainText(`IDEA-${number}`);
  const release = s.getByTestId('idea-release');
  await release.getByLabel('Версия Smartup').fill('5.12');
  await release.getByRole('button', { name: 'Выпущена' }).click();
  await expect(s.getByText('Идея отмечена выпущенной.')).toBeVisible();
  const released = await dbRows<{ recipient_user_id: string }>(`select recipient_user_id from hdn_outbox where payload ->> 'ideaId' = $1 and payload ->> 'event' = 'released'`, [mine!.idea_id]);
  expect(released.map((r) => r.recipient_user_id).sort()).toEqual(voters.map((v) => v.user_id).sort());

  // 9. Клиент видит "Выпущена" и выбор с объяснением в архиве отбора.
  await a.goto(`/ru/ideas/${number}`);
  await expect(a.getByTestId('idea-page')).toContainText('Выпущена в версии 5.12');
  await a.goto('/ru/ideas/cycles');
  const archived = a.getByTestId('cycles-archive').locator(`[data-cycle="${month}-01"]`);
  await expect(archived).toContainText(`I-${number}`);
  await expect(archived).toContainText(`Печать по складам нужна всем клиентам с филиалами ${word}`);
  expect(await serious(a)).toEqual([]);
  await b.goto('/en/ideas/cycles');
  const english = b.getByTestId('cycles-archive').locator(`[data-cycle="${month}-01"]`);
  await expect(english).toContainText(`Printing by warehouse helps every client with branches ${word}`);
  // Английский сотрудник поправил: пометки нет. Узбекский сохранён из черновика без правки: пометка "Машинный перевод"
  // (итоговая проверка M7, пункт M6).
  await expect(english).not.toContainText('Machine translation');
  await b.goto('/uz/ideas/cycles');
  await expect(b.getByTestId('cycles-archive').locator(`[data-cycle="${month}-01"]`)).toContainText(UZ_MACHINE);

  await Promise.all([clientA.close(), clientB.close(), staff.close()]);
});
