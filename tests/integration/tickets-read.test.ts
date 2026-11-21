import { expect, test } from 'vitest';
import { getTicket, listTickets } from '@/modules/hdt/api';
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
