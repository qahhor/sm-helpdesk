import { beforeEach, expect, test } from 'vitest';
import { asActor, pools } from './helpers/db';
import { type Fixture, seedTwoOrgs } from './isolation/fixture';

// Исправления по независимой проверке вехи M8: ужесточение политик и триггеров базы (находки m1 и m2).

let f: Fixture;
beforeEach(async () => {
  f = await seedTwoOrgs();
});

test('m1: клиент пишет только события своих действий; нарушение срока, смену приоритета и остальные виды от клиента база не принимает', async () => {
  const insert = (actor: Parameters<typeof asActor>[1], kind: string) =>
    asActor(pools.app, actor, (c) => c.query(`insert into hdc_domain_events (org_id, ticket_id, kind) values ($1, $2, $3)`, [f.orgA.orgId, f.tickets.aOrg.ticketId, kind]));
  for (const kind of ['ticket_created', 'client_replied', 'status_changed', 'rated']) await expect(insert(f.aUser.actor, kind), kind).resolves.toMatchObject({ rowCount: 1 });
  for (const kind of ['staff_replied', 'priority_changed', 'sla_soon', 'sla_breached', 'no_activity', 'ai_handoff'])
    await expect(insert(f.aUser.actor, kind), kind).rejects.toThrow(/row-level security/);
  // Сотрудник и система пишут любой вид, как раньше.
  await expect(insert(f.l1.actor, 'priority_changed')).resolves.toMatchObject({ rowCount: 1 });
  await expect(insert({ type: 'system', job: 'tickets.minute' }, 'sla_breached')).resolves.toMatchObject({ rowCount: 1 });
  // Срок повтора разбора при вставке не задаёт никто.
  await expect(
    asActor(pools.app, f.l1.actor, (c) => c.query(`insert into hdc_domain_events (org_id, ticket_id, kind, next_attempt_on) values ($1, $2, 'status_changed', now() + interval '1 year')`, [f.orgA.orgId, f.tickets.aOrg.ticketId])),
  ).rejects.toThrow(/row-level security/);
});

test('m2: клиент при создании обращения не задаёт служебные отметки: "срок скоро", сообщение дежурным, нарушение срока, напоминания', async () => {
  const create = (column?: string, value = 'now()') =>
    asActor(pools.app, f.aUser.actor, (c) =>
      c.query(
        `insert into hdt_tickets (org_id, author_id, type, impact, priority, visibility, title, description, locale, source${column ? `, ${column}` : ''})
         values ($1, $2, 'bug', 'blocker', 'p1', 'org', 'Склад стоит', 'Склад стоит: описание', 'ru', 'portal'${column ? `, ${value}` : ''})`,
        [f.orgA.orgId, f.aUser.userId],
      ),
    );
  // Обычное создание проходит.
  await expect(create()).resolves.toMatchObject({ rowCount: 1 });
  // Отметка "дежурным уже сообщили" у нового P1 отменила бы сообщение дежурным; остальные колонки тоже служебные.
  for (const column of ['oncall_notified_on', 'first_response_soon_on', 'resolution_soon_on', 'first_response_breached_on', 'resolution_breached_on', 'waiting_reminded_on', 'update_reminded_on', 'snooze_returned_on'])
    await expect(create(column), column).rejects.toMatchObject({ code: '42501' });
  await expect(create('resolved_version', `'5.15.0'`)).rejects.toMatchObject({ code: '42501' });
  await expect(create('sender_unconfirmed', 'true')).rejects.toMatchObject({ code: '42501' });
  await expect(create('csat_review_note', `'Разобрано'`)).rejects.toMatchObject({ code: '42501' });
});
