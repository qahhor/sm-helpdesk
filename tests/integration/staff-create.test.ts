import { expect, test } from 'vitest';
import { createTicketForClient, getTicket } from '@/modules/hdt/api';
import { clientCtx, staffCtx, staffWithRole } from './helpers/auth';
import { asActor, pools } from './helpers/db';
import { seedTwoOrgs } from './isolation/fixture';

// Обращение от имени клиента (FR-AG-08; план M3, задача 12): после звонка сотрудник заводит обращение за участника.

const input = (f: Awaited<ReturnType<typeof seedTwoOrgs>>, extra: Record<string, unknown> = {}) => ({
  orgId: f.orgA.orgId,
  authorId: f.aUser.userId,
  type: 'bug',
  impact: 'major',
  description: 'Звонок: у агентов не грузится отчёт по продажам за месяц',
  locale: 'uz',
  intakeChannel: 'phone',
  ...extra,
});
const row = (number: number) =>
  pools.root
    .query(
      `select ticket_id, org_id, author_id, source, priority, priority_confirmed, status, locale, created_on, first_response_due_on, resolution_due_on
         from hdt_tickets where number = $1`,
      [number],
    )
    .then((r) => r.rows[0]);

test('обращение за клиента: источник staff, автор участник организации, сроки от создания', async () => {
  const f = await seedTwoOrgs();
  const { number } = await createTicketForClient(staffCtx(f.l1), input(f, { priority: 'p1' }));
  const r = await row(number);
  expect(r).toMatchObject({ org_id: f.orgA.orgId, author_id: f.aUser.userId, source: 'staff', priority: 'p1', priority_confirmed: true, status: 'new', locale: 'uz' });
  expect(r.first_response_due_on).not.toBeNull();
  expect(r.resolution_due_on).not.toBeNull();
  // Без приоритета: по влиянию и не подтверждён, как у клиента.
  const second = await row((await createTicketForClient(staffCtx(f.l1), input(f))).number);
  expect(second).toMatchObject({ priority: 'p2', priority_confirmed: false });
  const watchers = await pools.root.query(`select user_id, source from hdt_ticket_watchers where ticket_id = $1`, [r.ticket_id]);
  expect(watchers.rows).toEqual([{ user_id: f.aUser.userId, source: 'author' }]);
  const events = await pools.root.query(`select kind, actor_type, actor_id from hdt_ticket_events where ticket_id = $1 and kind = 'created'`, [r.ticket_id]);
  expect(events.rows).toEqual([{ kind: 'created', actor_type: 'staff', actor_id: f.l1.userId }]);
  const audit = await pools.root.query(`select action from hdc_audit_log where object_id = $1`, [r.ticket_id]);
  expect(audit.rows.map((x) => x.action)).toContain('ticket.created');
});

test('участник другой организации или отключённый отклоняется', async () => {
  const f = await seedTwoOrgs();
  const l1 = staffCtx(f.l1);
  await expect(createTicketForClient(l1, input(f, { authorId: f.bUser.userId }))).rejects.toMatchObject({ code: 'invalid_input' });
  await expect(createTicketForClient(l1, input(f, { authorId: f.l1.userId }))).rejects.toMatchObject({ code: 'invalid_input' });
  await pools.root.query(`update hdu_memberships set state = 'passive' where org_id = $1 and user_id = $2`, [f.orgA.orgId, f.aAdmin.userId]);
  await expect(createTicketForClient(l1, input(f, { authorId: f.aAdmin.userId }))).rejects.toMatchObject({ code: 'invalid_input' });
  await expect(createTicketForClient(l1, input(f, { description: '' }))).rejects.toMatchObject({ code: 'invalid_input' });
  // Второй слой: сотрудник не заводит в базе обращение "с портала" в обход сервиса.
  await expect(
    asActor(pools.app, f.l1.actor, (c) =>
      c.query(
        `insert into hdt_tickets (org_id, author_id, type, impact, priority, title, description, locale, source)
         values ($1, $2, 'bug', 'minor', 'p3', 'x', 'x', 'ru', 'portal')`,
        [f.orgA.orgId, f.aUser.userId],
      ),
    ),
  ).rejects.toThrow(/сотрудник/);
});

test('клиент видит "создано сотрудником"', async () => {
  const f = await seedTwoOrgs();
  const { number } = await createTicketForClient(staffCtx(f.care), input(f, { visibility: 'private' }));
  const view = await getTicket(await clientCtx(f.aUser), number);
  expect(view).toMatchObject({ createdByStaff: true, visibility: 'private', isMine: true });
  expect(JSON.stringify(view)).not.toContain('Камила');
});

test('product не создаёт обращения', async () => {
  const f = await seedTwoOrgs();
  await expect(createTicketForClient(staffCtx(await staffWithRole('product')), input(f))).rejects.toMatchObject({ code: 'forbidden' });
});
