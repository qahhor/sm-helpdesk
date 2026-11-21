import { expect, test } from 'vitest';
import { findTicketInOtherOrganizations, getTicket, listTickets } from '@/modules/hdt/api';
import { clientCtx } from './helpers/auth';
import { pools } from './helpers/db';
import { seedTwoOrgs } from './isolation/fixture';

// Список и страница обращения клиента (FR-TK-06, FR-TK-07, FR-TK-17; ТЗ 15.2; план M2, задача 3).

const numbers = (items: { number: number }[]) => items.map((i) => i.number).sort((a, b) => a - b);

test('список: мои и организации, фильтр по статусу и типу, поиск по номеру и по тексту', async () => {
  const f = await seedTwoOrgs();
  const ctx = await clientCtx(f.aUser);
  const t = f.tickets;
  expect(numbers((await listTickets(ctx, {})).items)).toEqual(numbers([t.aOrg, t.aMine]));
  expect(numbers((await listTickets(ctx, { scope: 'mine' })).items)).toEqual(numbers([t.aOrg, t.aMine]));
  expect(numbers((await listTickets(await clientCtx(f.aAdmin), { scope: 'mine' })).items)).toEqual([t.aPrivate.number]);
  await pools.root.query(`update hdt_tickets set status = 'waiting_customer', type = 'question' where ticket_id = $1`, [t.aMine.ticketId]);
  expect(numbers((await listTickets(ctx, { status: 'waiting_customer' })).items)).toEqual([t.aMine.number]);
  expect(numbers((await listTickets(ctx, { type: 'bug' })).items)).toEqual([t.aOrg.number]);
  expect(numbers((await listTickets(ctx, { q: `SUP-${t.aOrg.number}` })).items)).toEqual([t.aOrg.number]);
  expect(numbers((await listTickets(ctx, { q: String(t.aMine.number) })).items)).toEqual([t.aMine.number]);
  expect(numbers((await listTickets(ctx, { q: 'отчёт а' })).items)).toEqual([t.aOrg.number]);
  // Знаки шаблона LIKE ищутся как текст.
  expect((await listTickets(ctx, { q: '%' })).items).toEqual([]);
  const row = (await listTickets(ctx, { q: String(t.aOrg.number) })).items[0];
  expect(row).toMatchObject({ number: t.aOrg.number, title: t.aOrg.title, status: 'new', type: 'bug', visibility: 'org', isMine: true });
  expect(row?.modifiedOn).toBeInstanceOf(Date);
  await expect(listTickets(ctx, { status: 'deleted' })).rejects.toMatchObject({ code: 'invalid_input' });
});

test('поиск цифрами находит и номер, и текст: код ошибки или номер документа из описания', async () => {
  const f = await seedTwoOrgs();
  const ctx = await clientCtx(f.aUser);
  const r = await pools.root.query(
    `insert into hdt_tickets (org_id, author_id, type, impact, priority, title, description, locale, source)
     values ($1, $2, 'bug', 'major', 'p2', 'Ошибка при печати', 'Сервер вернул ошибку 500 при печати накладной 77031', 'ru', 'portal') returning number`,
    [f.orgA.orgId, f.aUser.userId],
  );
  const created = Number(r.rows[0].number);
  expect(numbers((await listTickets(ctx, { q: '500' })).items)).toEqual([created]);
  expect(numbers((await listTickets(ctx, { q: '77031' })).items)).toEqual([created]);
  // Номер обращения по-прежнему находится и цифрами, и с приставкой.
  expect(numbers((await listTickets(ctx, { q: String(f.tickets.aMine.number) })).items)).toContain(f.tickets.aMine.number);
  expect(numbers((await listTickets(ctx, { q: `SUP-${created}` })).items)).toEqual([created]);
});

test('цифры ищутся в тексте как набраны, приставка SUP- ищет только номер (вторая проверка M2)', async () => {
  const f = await seedTwoOrgs();
  const ctx = await clientCtx(f.aUser);
  const insert = (description: string) =>
    pools.root
      .query(
        `insert into hdt_tickets (org_id, author_id, type, impact, priority, title, description, locale, source)
         values ($1, $2, 'bug', 'major', 'p2', 'Поиск', $3, 'ru', 'portal') returning number`,
        [f.orgA.orgId, f.aUser.userId, description],
      )
      .then((r) => Number(r.rows[0].number));
  const code = await insert('Ошибка 007 при печати');
  await insert('Не прошли 7 заказов');
  // "007" это код из описания, а не число 7: ведущие нули не теряются.
  expect(numbers((await listTickets(ctx, { q: '007' })).items)).toEqual([code]);
  // С приставкой SUP- ищется только номер; без неё число ищется и как номер, и в тексте.
  const mentions = await insert(`Похоже на обращение ${f.tickets.aMine.number}`);
  expect(numbers((await listTickets(ctx, { q: `SUP-${f.tickets.aMine.number}` })).items)).toEqual([f.tickets.aMine.number]);
  expect(numbers((await listTickets(ctx, { q: `sup-${f.tickets.aMine.number}` })).items)).toEqual([f.tickets.aMine.number]);
  expect(numbers((await listTickets(ctx, { q: String(f.tickets.aMine.number) })).items).sort()).toEqual([f.tickets.aMine.number, mentions].sort());
});

test('текст обращения Б не находится поиском пользователя А (15.2)', async () => {
  const f = await seedTwoOrgs();
  expect((await listTickets(await clientCtx(f.aAdmin), { q: 'Секрет Б' })).items).toEqual([]);
  expect((await listTickets(await clientCtx(f.aAdmin), { q: String(f.tickets.bOrg.number) })).items).toEqual([]);
});

test('обращение Б по номеру и личное обращение коллеги: null, как несуществующий номер (15.2)', async () => {
  const f = await seedTwoOrgs();
  const ctx = await clientCtx(f.aUser);
  for (const raw of [String(f.tickets.bOrg.number), `SUP-${f.tickets.aPrivate.number}`, 'SUP-999999999', 'мусор'])
    expect(await getTicket(ctx, raw), raw).toBeNull();
  expect(await getTicket(await clientCtx(f.aAdmin), String(f.tickets.aMine.number))).toMatchObject({ number: f.tickets.aMine.number, isMine: false });
});

test('страница: внутренних заметок, внутренних событий и непроверенных вложений нет', async () => {
  const f = await seedTwoOrgs();
  const view = await getTicket(await clientCtx(f.aUser), `SUP-${f.tickets.aOrg.number}`);
  expect(view).toMatchObject({
    number: f.tickets.aOrg.number,
    title: f.tickets.aOrg.title,
    description: `${f.tickets.aOrg.title}: подробное описание`,
    author: { id: f.aUser.userId, name: 'Алишер' },
    isMine: true,
    watching: true,
  });
  expect(view?.messages.map((m) => ({ body: m.body, authorType: m.authorType, isMine: m.isMine }))).toEqual([
    { body: 'Публичное сообщение', authorType: 'client', isMine: true },
  ]);
  expect(view?.events.map((e) => e.kind)).toEqual(['created']);
  expect(view?.attachments.map((a) => a.scanStatus)).toEqual(['clean']);
  expect(view?.attachments[0]).toMatchObject({ fileName: 'screenshot.png', mime: 'image/png', size: 1024, isImage: true });
});

test('чей ход: waiting_customer и resolved - клиент, new, in_progress, in_development - поддержка, closed - никто', async () => {
  const f = await seedTwoOrgs();
  const ctx = await clientCtx(f.aUser);
  const turn = async (status: string) => {
    await pools.root.query(`update hdt_tickets set status = $2, closed_on = case when $2 = 'closed' then now() end where ticket_id = $1`, [f.tickets.aOrg.ticketId, status]);
    return (await getTicket(ctx, String(f.tickets.aOrg.number)))?.turn;
  };
  expect(await turn('new')).toBe('support');
  expect(await turn('in_progress')).toBe('support');
  expect(await turn('in_development')).toBe('support');
  expect(await turn('waiting_customer')).toBe('client');
  expect(await turn('resolved')).toBe('client');
  expect(await turn('closed')).toBe('none');
});

test('разрешённые действия зависят от статуса, автора и роли', async () => {
  const f = await seedTwoOrgs();
  const t = f.tickets.aOrg;
  const can = async (member: { userId: string }, status: string, closedDaysAgo = 0) => {
    await pools.root.query(
      `update hdt_tickets set status = $2, closed_on = case when $2 = 'closed' then now() - make_interval(days => $3) end where ticket_id = $1`,
      [t.ticketId, status, closedDaysAgo],
    );
    return (await getTicket(await clientCtx(member), String(t.number)))?.can;
  };
  expect(await can(f.aUser, 'in_progress')).toEqual({ reply: true, confirm: false, reopen: false, rate: false, changeVisibility: true, watch: false });
  expect(await can(f.aUser, 'resolved')).toMatchObject({ reply: true, confirm: true, reopen: true });
  expect(await can(f.aUser, 'closed', 3)).toMatchObject({ reply: false, reopen: true, rate: true });
  expect(await can(f.aUser, 'closed', 15)).toMatchObject({ reopen: false, rate: true });
  // Администратор клиента меняет видимость чужого обращения и может подписаться.
  expect(await can(f.aAdmin, 'in_progress')).toMatchObject({ changeVisibility: true, watch: true });
});

test('обращение другой своей организации: страница не находит его в текущей, но подсказывает организацию (UX-C-06)', async () => {
  const f = await seedTwoOrgs();
  // Алишер состоит и в организации Б.
  await pools.root.query(`insert into hdu_memberships (org_id, user_id, role, source) values ($1, $2, 'client_user', 'invite')`, [f.orgB.orgId, f.aUser.userId]);
  // Активная организация А: последняя, в которую он входил.
  await pools.root.query(`update auth."user" set "lastOrgId" = $1 where id = $2`, [f.orgA.orgId, f.aUser.userId]);
  const ctx = await clientCtx(f.aUser);
  expect(ctx.actor.orgId).toBe(f.orgA.orgId);
  expect(await getTicket(ctx, String(f.tickets.bOrg.number))).toBeNull();
  const orgName = (await pools.root.query(`select name from hdu_organizations where org_id = $1`, [f.orgB.orgId])).rows[0].name as string;
  expect(await findTicketInOtherOrganizations(ctx, `SUP-${f.tickets.bOrg.number}`)).toEqual({ orgId: f.orgB.orgId, orgName });
  // Личное обращение коллеги в Б ему не видно и в Б: подсказки нет.
  expect(await findTicketInOtherOrganizations(ctx, String(f.tickets.bPrivate.number))).toBeNull();
  // Обращение своей текущей организации и несуществующий номер подсказки не дают.
  expect(await findTicketInOtherOrganizations(ctx, String(f.tickets.aOrg.number))).toBeNull();
  expect(await findTicketInOtherOrganizations(ctx, 'SUP-999999999')).toBeNull();
  // Не участнику Б номер ничего не говорит: ни страницы, ни подсказки.
  const stranger = await clientCtx(f.aAdmin);
  expect(await findTicketInOtherOrganizations(stranger, String(f.tickets.bOrg.number))).toBeNull();
  // Отключённое членство подсказки не даёт.
  await pools.root.query(`update hdu_memberships set state = 'passive' where org_id = $1 and user_id = $2`, [f.orgB.orgId, f.aUser.userId]);
  expect(await findTicketInOtherOrganizations(await clientCtx(f.aUser), String(f.tickets.bOrg.number))).toBeNull();
  // Гостевое членство входа не даёт, значит и подсказки: о чужом обращении гость не узнаёт (вторая проверка M2).
  await pools.root.query(`update hdu_memberships set state = 'active', source = 'guest' where org_id = $1 and user_id = $2`, [f.orgB.orgId, f.aUser.userId]);
  expect(await findTicketInOtherOrganizations(await clientCtx(f.aUser), String(f.tickets.bOrg.number))).toBeNull();
});

test('ставшее личным обращение пропадает у коллеги на следующем запросе (на что смотреть, 4)', async () => {
  const f = await seedTwoOrgs();
  const ctx = await clientCtx(f.aUser);
  await pools.root.query(`update hdt_tickets set visibility = 'org' where ticket_id = $1`, [f.tickets.aPrivate.ticketId]);
  expect(await getTicket(ctx, String(f.tickets.aPrivate.number))).not.toBeNull();
  await pools.root.query(`update hdt_tickets set visibility = 'private' where ticket_id = $1`, [f.tickets.aPrivate.ticketId]);
  expect(await getTicket(ctx, String(f.tickets.aPrivate.number))).toBeNull();
  expect(numbers((await listTickets(ctx, {})).items)).not.toContain(f.tickets.aPrivate.number);
});

test('листание по 20 без пропусков и повторов при одинаковом времени изменения', async () => {
  const f = await seedTwoOrgs();
  await pools.root.query(
    `insert into hdt_tickets (org_id, author_id, type, impact, priority, title, description, locale, source)
     select $1, $2, 'question', 'minor', 'p3', 'Массовое ' || n, 'Описание ' || n, 'ru', 'portal' from generate_series(1, 45) n`,
    [f.orgA.orgId, f.aUser.userId],
  );
  const ctx = await clientCtx(f.aUser);
  const seen: number[] = [];
  let cursor: string | null = null;
  let pages = 0;
  do {
    const page: Awaited<ReturnType<typeof listTickets>> = await listTickets(ctx, cursor ? { cursor } : {});
    expect(page.items.length).toBeLessThanOrEqual(20);
    seen.push(...page.items.map((i) => i.number));
    cursor = page.nextCursor;
    pages++;
  } while (cursor && pages < 10);
  expect(pages).toBe(3);
  expect(seen).toHaveLength(47);
  expect(new Set(seen).size).toBe(47);
  await expect(listTickets(ctx, { cursor: 'не курсор' })).rejects.toMatchObject({ code: 'invalid_input' });
});
