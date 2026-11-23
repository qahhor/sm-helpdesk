import { beforeEach, expect, test } from 'vitest';
import { getAgentTicket, getTicket } from '@/modules/hdt/api';
import { clientCtx, staffCtx } from './helpers/auth';
import { captureQueries } from './helpers/bulk';
import { pools } from './helpers/db';
import { type Fixture, seedTwoOrgs } from './isolation/fixture';

// История обращения частями (аудит 23.11.2026, находка P11; план W2, задача 6): страница читает последние 50
// записей, остальные по ссылке "Показать раньше". Раньше читалась вся переписка, сколько бы её ни было.

let f: Fixture;
let ticketId: string;
let number: number;

/** 300 сообщений клиента и сотрудника, каждое пятое внутренняя заметка, и 30 событий. Времена идут подряд, часть совпадает. */
beforeEach(async () => {
  f = await seedTwoOrgs();
  ticketId = f.tickets.aOrg.ticketId;
  number = f.tickets.aOrg.number;
  const root = await pools.root.connect();
  try {
    await root.query('begin');
    await root.query(`set local session_replication_role = replica`);
    await root.query(
      `insert into hdt_ticket_messages (org_id, ticket_id, author_id, author_type, body, is_internal, created_on)
       select $1, $2, case when g % 2 = 0 then $3::uuid else $4::uuid end, case when g % 2 = 0 then 'client' else 'staff' end,
              'Сообщение ' || g, g % 5 = 1, now() + interval '1 minute' + ((g / 3) || ' seconds')::interval
         from generate_series(1, 300) g`,
      [f.orgA.orgId, ticketId, f.aUser.userId, f.l1.userId],
    );
    await root.query(
      `insert into hdt_ticket_events (org_id, ticket_id, kind, actor_type, actor_id, payload, is_internal, created_on)
       select $1, $2, 'priority', 'staff', $3, jsonb_build_object('from', 'p3', 'to', 'p2', 'n', g), true, now() + interval '1 minute' + ((g * 3) || ' seconds')::interval
         from generate_series(1, 30) g`,
      [f.orgA.orgId, ticketId, f.l1.userId],
    );
    await root.query('commit');
  } finally {
    root.release();
  }
});

const idsOf = (view: NonNullable<Awaited<ReturnType<typeof getAgentTicket>>>) => view.timeline.map((entry) => `${entry.type}:${entry.id}`);

test('страница обращения сотрудника показывает последние 50 записей и говорит, что есть раньше', async () => {
  const { result: view, queries } = await captureQueries(() => getAgentTicket(staffCtx(f.l1), number));
  expect(view?.timeline).toHaveLength(50);
  expect(view?.hasEarlier).toBe(true);
  expect(view?.shown).toBe(50);
  const last = view?.timeline.at(-1);
  expect(last?.type === 'message' ? last.body : null).toBe('Сообщение 300');
  // Вся переписка из базы не читается: каждый запрос к сообщениям и событиям ограничен.
  const unbounded = queries.filter((q) => /from "?hdt_ticket_(messages|events)"?/.test(q.text) && !/limit|in \(/i.test(q.text) && !/max\(/i.test(q.text));
  expect(unbounded.map((q) => q.text.slice(0, 120))).toEqual([]);
});

test('"показать раньше" добавляет следующие 50 без пропусков и повторов, даже при одинаковом времени записей', async () => {
  const l1 = staffCtx(f.l1);
  const page1 = idsOf((await getAgentTicket(l1, number))!);
  const page2 = idsOf((await getAgentTicket(l1, number, { shown: 100 }))!);
  const page3 = idsOf((await getAgentTicket(l1, number, { shown: 150 }))!);
  expect(page2).toHaveLength(100);
  expect(new Set(page2).size).toBe(100);
  expect(page2.slice(50)).toEqual(page1);
  expect(page3.slice(50)).toEqual(page2);
  // Вся история: 300 сообщений, 30 событий и записи заготовки, ни одной не потеряно.
  const all = (await getAgentTicket(l1, number, { shown: 1000 }))!;
  expect(all.hasEarlier).toBe(false);
  const total = (await pools.root.query(`select (select count(*) from hdt_ticket_messages where ticket_id = $1)::int + (select count(*) from hdt_ticket_events where ticket_id = $1 and kind <> 'created')::int as n`, [ticketId])).rows[0].n;
  expect(all.timeline).toHaveLength(total);
  expect(idsOf(all).slice(-150)).toEqual(page3);
});

test('версия страницы и граница "новое" считаются по всей истории, а не по показанной части', async () => {
  const l1 = staffCtx(f.l1);
  const short = (await getAgentTicket(l1, number))!;
  const full = (await getAgentTicket(l1, number, { shown: 1000 }))!;
  expect(short.version).toBe(full.version);
  // Негодное значение параметра не ломает страницу: показываются последние 50.
  for (const bad of ['abc', -5, 0, 1e9, null]) expect((await getAgentTicket(l1, number, { shown: bad }))?.timeline.length).toBeGreaterThanOrEqual(50);
  expect((await getAgentTicket(l1, number, { shown: 1e9 }))?.shown).toBe(1000);
});

test('клиент видит последние 50 своих записей, внутренних нет ни на одной странице', async () => {
  const ctx = await clientCtx(f.aUser);
  const first = (await getTicket(ctx, number))!;
  expect(first.messages.length + first.events.length).toBe(50);
  expect(first.hasEarlier).toBe(true);
  expect(first.messages.at(-1)?.body).toBe('Сообщение 300');
  const all = (await getTicket(ctx, number, { shown: 1000 }))!;
  expect(all.hasEarlier).toBe(false);
  const visible = (await pools.root.query(`select count(*)::int as n from hdt_ticket_messages where ticket_id = $1 and not is_internal`, [ticketId])).rows[0].n;
  expect(all.messages).toHaveLength(visible);
  expect(all.messages.some((m) => /^Сообщение (1|6|11|296)$/.test(m.body))).toBe(false);
  expect(all.events.every((e) => e.kind !== 'priority')).toBe(true);
  // Страницы вложены: вторая страница заканчивается первой.
  const second = (await getTicket(ctx, number, { shown: 100 }))!;
  expect(second.messages.slice(-first.messages.length).map((m) => m.messageId)).toEqual(first.messages.map((m) => m.messageId));
});
