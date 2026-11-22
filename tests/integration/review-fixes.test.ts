import { expect, test } from 'vitest';
import {
  createTicket,
  getAgentTicket,
  listQueue,
  loadDraft,
  mergeTicket,
  postStaffMessage,
  saveDraft,
  setPriority,
  setStatus,
  takeTicket,
  ticketsMinute,
  transferToL2,
} from '@/modules/hdt/api';
import { clientCtx, staffCtx, staffWithRole } from './helpers/auth';
import { asActor, pools } from './helpers/db';
import { seedTwoOrgs } from './isolation/fixture';

// Исправления по итоговой независимой проверке ветки M3 (docs/plans/M3-report.md).

const SYSTEM = { type: 'system', job: 'tickets.minute' } as const;
const NOTE = { reason: 'suspected_bug', checked: 'Проверили права', needed: 'Посмотреть журнал' };
const row = (ticketId: string) =>
  pools.root
    .query(`select status, queue, assignee_id, resolution_due_on, resolution_breached_on, sla_paused_on from hdt_tickets where ticket_id = $1`, [ticketId])
    .then((r) => r.rows[0]);
const version = async (ctx: ReturnType<typeof staffCtx>, number: number) => (await getAgentTicket(ctx, number))?.version ?? '';
const newTicket = async (member: { userId: string }, description: string) => {
  const { number } = await createTicket(await clientCtx(member), { description, type: 'bug', impact: 'minor', locale: 'ru' });
  return { number, ticketId: (await pools.root.query(`select ticket_id from hdt_tickets where number = $1`, [number])).rows[0].ticket_id as string };
};

test('объединённое обращение сотрудник не открывает и не отвечает в нём клиенту; база тоже не даёт', async () => {
  const f = await seedTwoOrgs();
  const l1 = staffCtx(f.l1);
  const dup = await newTicket(f.aUser, 'Дубль');
  await mergeTicket(l1, { number: dup.number, intoNumber: f.tickets.aOrg.number });
  await expect(setStatus(l1, { number: dup.number, to: 'in_progress' })).rejects.toMatchObject({ code: 'merged' });
  await expect(postStaffMessage(l1, { number: dup.number, body: 'Ответ в дубле', internal: false, seenVersion: await version(l1, dup.number) })).rejects.toMatchObject({
    code: 'merged',
  });
  // Заметка в дубле остаётся можно: клиент её не видит.
  expect(await postStaffMessage(l1, { number: dup.number, body: 'Заметка в дубле', internal: true, seenVersion: await version(l1, dup.number) })).toEqual({ ok: true });
  expect((await getAgentTicket(l1, dup.number))?.mergedInto).not.toBeNull();
  await expect(asActor(pools.app, f.l1.actor, (c) => c.query(`update hdt_tickets set status = 'in_progress' where ticket_id = $1`, [dup.ticketId]))).rejects.toThrow(/объединён/);
  expect((await row(dup.ticketId)).status).toBe('closed');
});

test('сотрудник закрывает только решённое обращение: из "Ждём вашего ответа" закрывает только задача', async () => {
  const f = await seedTwoOrgs();
  const l1 = staffCtx(f.l1);
  const t = f.tickets.aOrg;
  await setStatus(l1, { number: t.number, to: 'waiting_customer' });
  await expect(setStatus(l1, { number: t.number, to: 'closed' })).rejects.toMatchObject({ code: 'transition_refused' });
  expect((await row(t.ticketId)).status).toBe('waiting_customer');
});

test('переданное на вторую линию не в "Новых" первой линии, и первая линия его не берёт', async () => {
  const f = await seedTwoOrgs();
  const l1 = staffCtx(f.l1);
  const t = await newTicket(f.aUser, 'Новое для второй линии');
  await transferToL2(l1, { number: t.number, ...NOTE });
  expect((await listQueue(l1, { queue: 'new' })).items.map((r) => r.number)).not.toContain(t.number);
  expect((await listQueue(l1, { queue: 'l2' })).items.map((r) => r.number)).toContain(t.number);
  await expect(takeTicket(l1, t.number)).rejects.toMatchObject({ code: 'forbidden' });
  const l2 = staffCtx(await staffWithRole('agent_l2'));
  await takeTicket(l2, t.number);
  expect((await row(t.ticketId)).assignee_id).toBe(l2.actor.userId);
});

test('"В разработке" и возврат со второй линии база разрешает только второй линии, care и admin (42501)', async () => {
  const f = await seedTwoOrgs();
  const t = f.tickets.aOrg;
  await pools.root.query(`update hdt_tickets set status = 'in_progress', queue = 'l2' where ticket_id = $1`, [t.ticketId]);
  await expect(asActor(pools.app, f.l1.actor, (c) => c.query(`update hdt_tickets set status = 'in_development' where ticket_id = $1`, [t.ticketId]))).rejects.toThrow(
    /разработке/,
  );
  await expect(asActor(pools.app, f.l1.actor, (c) => c.query(`update hdt_tickets set queue = 'l1' where ticket_id = $1`, [t.ticketId]))).rejects.toThrow(/линию/);
  await expect(
    asActor(pools.app, f.l1.actor, (c) =>
      c.query(`insert into hdt_ticket_line_transfers (ticket_id, from_line, to_line, explanation, by_user) values ($1, 'l2', 'l1', 'Сам себе', $2)`, [
        t.ticketId,
        f.l1.userId,
      ]),
    ),
  ).rejects.toThrow(/row-level security/);
  const l2 = (await staffWithRole('agent_l2')).actor;
  expect(await asActor(pools.app, l2, (c) => c.query(`update hdt_tickets set status = 'in_development' where ticket_id = $1`, [t.ticketId]).then((r) => r.rowCount))).toBe(1);
});

test('решённое и открытое снова через 3 дня: время в "Решено" не съедает срок, нарушения сразу нет', async () => {
  const f = await seedTwoOrgs();
  const l1 = staffCtx(f.l1);
  const t = await newTicket(f.aUser, 'Решили, потом вернулось');
  await setPriority(l1, { number: t.number, priority: 'p2', reason: 'Подтверждаю' });
  await takeTicket(l1, t.number);
  await setStatus(l1, { number: t.number, to: 'resolved', resolution: 'solved' });
  const before = await row(t.ticketId);
  expect(before.sla_paused_on).not.toBeNull();
  // Решено три дня назад: сдвигаем моменты решения в прошлое в обход триггеров.
  const client = await pools.root.connect();
  try {
    await client.query('begin');
    await client.query('set local session_replication_role = replica');
    await client.query(`update hdt_tickets set sla_paused_on = sla_paused_on - interval '3 days', resolved_on = resolved_on - interval '3 days' where ticket_id = $1`, [t.ticketId]);
    await client.query(`update hdt_ticket_events set created_on = created_on - interval '3 days' where ticket_id = $1 and kind = 'status' and payload->>'to' = 'resolved'`, [t.ticketId]);
    await client.query('commit');
  } finally {
    client.release();
  }
  await setStatus(l1, { number: t.number, to: 'in_progress' });
  const after = await row(t.ticketId);
  expect(after.sla_paused_on).toBeNull();
  expect(after.resolution_due_on.getTime()).toBeGreaterThan(before.resolution_due_on.getTime());
  await ticketsMinute(SYSTEM, new Date());
  expect((await row(t.ticketId)).resolution_breached_on).toBeNull();
});

test('черновик, пришедший после отправки с тем же текстом, не воскресает', async () => {
  const f = await seedTwoOrgs();
  const l1 = staffCtx(f.l1);
  const t = f.tickets.aOrg;
  await postStaffMessage(l1, { number: t.number, body: 'Проверили, всё в порядке', internal: false, seenVersion: await version(l1, t.number) });
  // Отложенное сохранение черновика опоздало и пришло уже после отправки.
  await saveDraft(l1, { number: t.number, body: 'Проверили, всё в порядке', internal: false });
  expect(await loadDraft(l1, t.number)).toBeNull();
  // Новый текст сохраняется как обычно.
  await saveDraft(l1, { number: t.number, body: 'Проверили, всё в порядке. И ещё', internal: false });
  expect(await loadDraft(l1, t.number)).toMatchObject({ body: 'Проверили, всё в порядке. И ещё' });
});

test('сбой одного шага задачи раз в минуту не останавливает остальные', async () => {
  const f = await seedTwoOrgs();
  const t = f.tickets.aOrg;
  await setPriority(staffCtx(f.l1), { number: t.number, priority: 'p1', reason: 'Стоит склад' });
  await pools.root.query(`update hdt_tickets set first_response_due_on = now() - interval '1 hour' where ticket_id = $1`, [t.ticketId]);
  // Испорченный календарь: досчёт сроков и автозакрытие падают, отметка нарушений календаря не требует.
  await pools.root.query(
    `insert into hdr_business_calendars (code, timezone, week_hours) values ('default', 'Asia/Tashkent', '{"0":null,"1":null,"2":null,"3":null,"4":null,"5":null,"6":null}')
     on conflict (code) do update set week_hours = excluded.week_hours`,
  );
  await pools.root.query(`update hdt_tickets set first_response_due_on = null where ticket_id = $1`, [f.tickets.aMine.ticketId]);
  const errors: unknown[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => void errors.push(args.join(' '));
  try {
    const result = await ticketsMinute(SYSTEM, new Date());
    expect(result.breached).toBeGreaterThanOrEqual(1);
  } finally {
    console.error = original;
  }
  expect(errors.join('\n')).toMatch(/tickets\.minute/);
});
