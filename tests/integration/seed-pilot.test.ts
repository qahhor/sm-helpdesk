import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, expect, test } from 'vitest';
import { runCli } from '@/cli/commands';
import { pools } from './helpers/db';
import { memoryMailerPerTest } from './helpers/mail';

// Команда начальных данных hub seed:pilot (план подготовки M9, задача 6, решение 9): первый запуск создаёт, второй ничего
// не меняет и не пишет в журнал аудита, сухой прогон ничего не пишет, решения остаются черновиками, сотрудники получают
// приглашения, ошибка в одной записи ничего не меняет и называет запись. Данных клиентов команда не создаёт никогда.

const box = memoryMailerPerTest();
const ADMIN_EMAIL = 'seed-admin@smartup.example';
let adminId = '';
const dir = mkdtempSync(join(tmpdir(), 'hub-seed-'));

beforeEach(async () => {
  adminId = (
    await pools.root.query(`insert into auth."user" (name, email, "emailVerified") values ('Администратор', $1, true) returning id`, [ADMIN_EMAIL])
  ).rows[0].id as string;
  await pools.root.query(`insert into hdu_staff (user_id, role) values ($1, 'admin')`, [adminId]);
});

function seedFile(patch: (file: Record<string, unknown> & { [key: string]: never }) => void = () => {}): string {
  const file = JSON.parse(readFileSync('docs/pilot/seed.example.json', 'utf8'));
  file.staff = [
    { email: 'l1-seed@smartup.example', name: 'Агент первой линии', role: 'agent_l1' },
    { email: 'product-seed@smartup.example', name: 'Продукт', role: 'product', locale: 'uz' },
  ];
  // По умолчанию per_user: значение из кода совпадает с файлом примера, и записывать нечего. Здесь другое значение.
  file.settings = { ideasVoteMode: 'per_org' };
  file.sla = { policies: [{ priority: 'p1', firstResponseMinutes: 20, resolutionMinutes: 300, clock: '24x7' }] };
  patch(file as never);
  const path = join(dir, `seed-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(path, JSON.stringify(file, null, 2));
  return path;
}

async function run(args: string[]) {
  const lines: string[] = [];
  const errors: string[] = [];
  const code = await runCli(args, {
    env: process.env,
    out: (line) => void lines.push(line),
    err: (line) => void errors.push(line),
    readSecret: async () => '',
  });
  return { code, lines, errors };
}

const seed = (path: string, extra: string[] = []) => run(['seed:pilot', '--file', path, '--admin', ADMIN_EMAIL, ...extra]);

/** Всё, что команда может изменить, и то, чего она не должна трогать никогда. */
async function snapshot() {
  const q = async (sql: string) => (await pools.root.query(sql)).rows;
  return {
    modules: await q(`select m.code, p.code as parent, m.name, m.screens, m.state, m.modified_on from hdr_product_modules m left join hdr_product_modules p on p.module_id = m.parent_id order by m.code`),
    calendar: await q(`select timezone, week_hours, array(select to_char(d, 'YYYY-MM-DD') from unnest(holidays) d) as holidays, modified_on from hdr_business_calendars`),
    sla: await q(`select priority, first_response_minutes, resolution_minutes, resolution_days, clock, modified_on from hdr_sla_policies order by priority`),
    templates: await q(`select shortcut, title, body, module_id, is_enabled, modified_on from hdr_reply_templates order by shortcut`),
    playbooks: await q(`select module_id, ticket_type, body, modified_on from hdr_l1_playbooks order by ticket_type`),
    tags: await q(`select name, color, modified_on from hdr_tags order by name`),
    settings: await q(`select code, value, modified_on from hdc_settings order by code`),
    invitations: await q(`select email, role, is_lead, revoked_on, accepted_on from hdu_invitations order by email`),
    articles: await q(`select a.status, a.audience, a.module_id, v.locale, v.title, v.state from hdk_articles a join hdk_article_versions v using (article_id) order by v.title`),
    published: await q(`select count(*)::int as n from hdk_published`),
    audit: await q(`select count(*)::int as n from hdc_audit_log`),
    clients: await q(
      `select (select count(*)::int from hdu_organizations) as orgs, (select count(*)::int from hdu_memberships) as members,
              (select count(*)::int from hdt_tickets) as tickets,
              (select count(*)::int from auth."user" u where not exists (select 1 from hdu_staff s where s.user_id = u.id)) as client_users`,
    ),
  };
}

test('первый запуск создаёт справочники, приглашения и черновики от имени администратора, второй ничего не меняет', async () => {
  const path = seedFile();
  const first = await seed(path);
  expect(first.errors).toEqual([]);
  expect(first.code).toBe(0);
  const after = await snapshot();
  expect(after.modules.map((m) => [m.code, m.state])).toEqual([
    ['trade', 'active'],
    ['warehouse', 'active'],
  ]);
  expect(after.calendar[0]?.holidays).toContain('2027-03-21');
  expect(after.sla).toMatchObject([{ priority: 'p1', first_response_minutes: 20, resolution_minutes: 300, clock: '24x7' }]);
  expect(after.templates.map((t) => t.shortcut)).toEqual(['rights', 'stock', 'version']);
  expect(after.templates.find((t) => t.shortcut === 'version')?.body).toMatchObject({ ru: expect.any(String), uz: expect.any(String), en: expect.any(String) });
  expect(after.playbooks).toMatchObject([{ ticket_type: 'bug' }]);
  expect(after.tags).toMatchObject([{ name: 'Пилот', color: 'teal' }]);
  expect(after.settings).toMatchObject([{ code: 'ideas.vote_mode', value: 'per_org' }]);
  expect(after.invitations).toMatchObject([
    { email: 'l1-seed@smartup.example', role: 'agent_l1', revoked_on: null, accepted_on: null },
    { email: 'product-seed@smartup.example', role: 'product', revoked_on: null, accepted_on: null },
  ]);
  expect(box.mailer.sent.map((mail) => [mail.to, mail.kind])).toEqual([
    ['l1-seed@smartup.example', 'staff-invitation'],
    ['product-seed@smartup.example', 'staff-invitation'],
  ]);
  // Решение только черновиком: опубликованной версии нет (FR-SOL-04 требует человека).
  expect(after.articles).toEqual([{ status: 'active', audience: 'clients', module_id: expect.any(String), locale: 'ru', title: 'Остатки на складе не обновились после документа', state: 'draft' }]);
  expect(after.published).toEqual([{ n: 0 }]);
  expect(after.clients).toEqual([{ orgs: 0, members: 0, tickets: 0, client_users: 0 }]);
  // Каждая запись журнала от имени администратора --admin.
  const actors = (await pools.root.query(`select distinct actor_type, actor_id from hdc_audit_log`)).rows;
  expect(actors).toEqual([{ actor_type: 'staff', actor_id: adminId }]);
  expect(first.lines.join('\n')).toMatch(/Шаблоны ответов: создано 3/);

  const second = await seed(path);
  expect(second.errors).toEqual([]);
  expect(second.code).toBe(0);
  expect(await snapshot()).toEqual(after);
  expect(box.mailer.sent).toHaveLength(2);
  expect(second.lines.at(-1)).toBe('Изменений нет: база уже совпадает с файлом.');
});

test('сухой прогон показывает, что изменилось бы, и ничего не пишет', async () => {
  const before = await snapshot();
  const result = await seed(seedFile(), ['--dry-run']);
  expect(result.errors).toEqual([]);
  expect(result.code).toBe(0);
  expect(result.lines[0]).toMatch(/Сухой прогон/);
  expect(result.lines.join('\n')).toMatch(/Модули: добавлено 2/);
  expect(result.lines.join('\n')).toMatch(/Сотрудники: приглашено 2/);
  expect(await snapshot()).toEqual(before);
  expect(box.mailer.sent).toEqual([]);
});

test('ошибка в одной записи ничего не меняет и называет запись', async () => {
  const before = await snapshot();
  const broken = await seed(
    seedFile((file) => {
      (file.templates as unknown as { body: { en?: string } }[])[1]!.body.en = '';
    }),
  );
  expect(broken.code).toBe(1);
  expect(broken.errors.join('\n')).toMatch(/templates, запись 2 \(rights\): body\.en/);
  // Ссылка на модуль, которого нет ни в файле, ни в справочнике.
  const unknownModule = await seed(
    seedFile((file) => {
      (file.playbooks as unknown as { module: string }[])[0]!.module = 'nowhere';
    }),
  );
  expect(unknownModule.code).toBe(1);
  expect(unknownModule.errors.join('\n')).toMatch(/playbooks, запись 1: модуль nowhere не найден/);
  expect(await snapshot()).toEqual(before);
});

test('файл с организациями или обращениями отклоняется целиком; от не администратора команда не работает', async () => {
  const before = await snapshot();
  const withOrgs = await seed(seedFile((file) => void ((file as Record<string, unknown>).organizations = [{ name: 'ACME' }])));
  expect(withOrgs.code).toBe(1);
  expect(withOrgs.errors.join('\n')).toContain('поле organizations не допускается');
  const withTickets = await seed(seedFile((file) => void ((file as Record<string, unknown>).tickets = [])));
  expect(withTickets.code).toBe(1);
  const notAdmin = await run(['seed:pilot', '--file', seedFile(), '--admin', 'nobody@smartup.example']);
  expect(notAdmin.code).toBe(1);
  expect(await snapshot()).toEqual(before);
});

test('изменённая запись обновляется, приглашение принятого сотрудника не повторяется, черновик не перезаписывается', async () => {
  const path = seedFile();
  expect((await seed(path)).code).toBe(0);
  // Сотрудник принял приглашение: строка сотрудника есть, повтор файла его не трогает.
  const l1 = (await pools.root.query(`insert into auth."user" (name, email, "emailVerified") values ('Агент', 'l1-seed@smartup.example', true) returning id`)).rows[0].id;
  await pools.root.query(`insert into hdu_staff (user_id, role) values ($1, 'agent_l1')`, [l1]);
  await pools.root.query(`update hdu_invitations set accepted_on = now() where email = 'l1-seed@smartup.example'`);
  const changed = seedFile((file) => {
    (file.templates as unknown as { title: string }[])[0]!.title = 'Версия и снимок экрана';
    (file.solutions as unknown as { doc: { blocks: unknown[] } }[])[0]!.doc.blocks.pop();
  });
  const auditBefore = (await pools.root.query(`select count(*)::int as n from hdc_audit_log`)).rows[0].n as number;
  const result = await seed(changed);
  expect(result.code).toBe(0);
  expect(result.lines.join('\n')).toMatch(/Шаблоны ответов: создано 0, изменено 1, без изменений 2/);
  expect((await pools.root.query(`select title from hdr_reply_templates where shortcut = 'version'`)).rows).toEqual([{ title: 'Версия и снимок экрана' }]);
  expect((await pools.root.query(`select action from hdc_audit_log order by created_on offset $1`, [auditBefore])).rows).toEqual([{ action: 'template.saved' }]);
  expect(box.mailer.sent).toHaveLength(2);
});

test('черновик из файла не создаётся второй раз, даже когда решений больше, чем показывает список (200)', async () => {
  const path = seedFile();
  expect((await seed(path)).code).toBe(0);
  // 200 более новых решений: черновик из файла уходит за первую страницу списка решений.
  const author = (await pools.root.query(`select user_id from hdu_staff where role = 'admin' limit 1`)).rows[0].user_id as string;
  await pools.root.query(
    `with a as (
       insert into hdk_articles (owner_id, original_locale, audience) select $1::uuid, 'ru', 'internal' from generate_series(1, 200) returning article_id
     )
     insert into hdk_article_versions (article_id, locale, number, title, doc, state, modified_on)
     select article_id, 'ru', 1, 'Другое решение ' || article_id, '{"version": 1, "blocks": []}'::jsonb, 'draft', now() + interval '1 hour' from a`,
    [author],
  );
  const result = await seed(path);
  expect(result.lines.join('\n')).toMatch(/Решения \(черновики\): создано 0, уже есть 1/);
  expect((await pools.root.query(`select count(*)::int as n from hdk_article_versions where title = 'Остатки на складе не обновились после документа'`)).rows).toEqual([{ n: 1 }]);
});
