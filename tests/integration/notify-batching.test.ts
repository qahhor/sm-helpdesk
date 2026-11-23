import { beforeEach, expect, test } from 'vitest';
import { getAgentTicket, postStaffMessage, returnToL1, transferToL2 } from '@/modules/hdt/api';
import { staffCtx } from './helpers/auth';
import { countTransactions, maxAppConnections } from './helpers/bulk';
import { pools } from './helpers/db';
import { linkTelegramFixture, memoryBotPerTest } from './helpers/telegram';
import { type Fixture, seedTwoOrgs } from './isolation/fixture';

// Уведомления без транзакции на каждого получателя (аудит 23.11.2026, находки A4 и P5; план W1, задача 5).
// Роли получателей и действие Telegram читаются одним запросом на всех, а не по два запроса на человека.

memoryBotPerTest();
let f: Fixture;
beforeEach(async () => {
  f = await seedTwoOrgs();
});

const versionOf = async (number: number) => (await getAgentTicket(staffCtx(f.l1), number))?.version ?? '';

/** Добавляет в организацию участников и подписывает их на обращение. */
async function watchers(n: number): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 0; i < n; i++) {
    const id = (await pools.root.query(`insert into auth."user" (name, email, "emailVerified") values ($1, $2, true) returning id`, [`Наблюдатель ${i}`, `watcher-${i}@acme.test`])).rows[0].id as string;
    await pools.root.query(`insert into hdu_memberships (user_id, org_id, role, source, state) values ($1, $2, 'client_user', 'smartup', 'active')`, [id, f.orgA.orgId]);
    await pools.root.query(`insert into hdt_ticket_watchers (org_id, ticket_id, user_id, source) values ($1, $2, $3, 'manual')`, [f.orgA.orgId, f.tickets.aOrg.ticketId, id]);
    ids.push(id);
  }
  return ids;
}

test('ответ сотрудника с 10 наблюдателями: число транзакций не растёт с числом получателей', async () => {
  const t = f.tickets.aOrg;
  const ids = await watchers(10);
  await linkTelegramFixture({ userId: ids[0]! }, 880001);
  const seenVersion = await versionOf(t.number);
  const counted = await countTransactions(() => postStaffMessage(staffCtx(f.l1), { number: t.number, body: 'Ответ всем', internal: false, seenVersion }));
  // Раньше: по две транзакции библиотеки входа на каждого получателя (роль и Telegram), всего больше 22.
  expect(counted.auth).toBeLessThanOrEqual(4);
  expect(counted.app).toBeLessThanOrEqual(6);
  // Поведение прежнее: уведомление в портале каждому, письмо каждому, одному ещё и Telegram.
  const notices = (await pools.root.query(`select count(*)::int as n from hdn_notifications where ticket_id = $1 and kind = 'ticket_reply' and payload ? 'title'`, [t.ticketId])).rows[0].n;
  expect(notices).toBe(11);
  const queued = (await pools.root.query(`select channel, count(*)::int as n from hdn_outbox where ticket_id = $1 and status = 'queued' group by channel order by channel`, [t.ticketId])).rows;
  expect(queued).toEqual([
    { channel: 'email', n: 11 },
    { channel: 'telegram', n: 1 },
  ]);
});

test('возврат на первую линию не открывает вторую транзакцию приложения внутри первой', async () => {
  const t = f.tickets.aOrg;
  await pools.root.query(`update hdt_tickets set status = 'in_progress', assignee_id = $2 where ticket_id = $1`, [t.ticketId, f.l1.userId]);
  await transferToL2(staffCtx(f.l1), { number: t.number, reason: 'suspected_bug', checked: 'Проверено', needed: 'Нужно исправить', checklist: [] });
  // На второй линии обращение взял другой сотрудник: при возврате исполнитель меняется, и в событие нужно имя.
  await pools.root.query(`update hdt_tickets set assignee_id = $2 where ticket_id = $1`, [t.ticketId, f.care.userId]);
  // Одно соединение пула за раз: вторая транзакция того же пула внутри первой при занятом пуле ждала бы саму себя.
  const counted = await maxAppConnections(() => returnToL1(staffCtx(f.care), { number: t.number, explanation: 'Исправлено, верните клиенту' }));
  expect(counted.max).toBe(1);
  {
    expect((await pools.root.query(`select assignee_id from hdt_tickets where ticket_id = $1`, [t.ticketId])).rows[0].assignee_id).toBe(f.l1.userId);
    // Имя прежнего исполнителя попало в событие: оно прочитано до транзакции.
    const event = (await pools.root.query(`select payload from hdt_ticket_events where ticket_id = $1 and kind = 'assignee' order by created_on desc limit 1`, [t.ticketId])).rows[0];
    expect(JSON.stringify(event?.payload ?? {})).toContain(f.l1.name);
  }
});
