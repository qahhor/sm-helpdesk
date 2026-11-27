import { expect, test } from 'vitest';
import { createTicket, createTicketForClient, getTicket, listTickets } from '@/modules/hdt/api';
import { clientCtx, staffCtx } from './helpers/auth';
import { pools } from './helpers/db';
import { seedTwoOrgs } from './isolation/fixture';

// Отметка "откуда пришло" у обращения, созданного сотрудником от имени клиента (план M9, задача 3, решение 12; ТЗ 16.7,
// решение ТЗ 83). Поле обязательное: telegram, phone, email_direct, jira, other. У обращений портала, виджета и почты
// поле пусто, это проверяет база. Клиент поле не получает ни в странице обращения, ни в списке.

const input = (f: Awaited<ReturnType<typeof seedTwoOrgs>>, extra: Record<string, unknown> = {}) => ({
  orgId: f.orgA.orgId,
  authorId: f.aUser.userId,
  type: 'question',
  impact: 'minor',
  description: 'Клиент сообщил: не открывается отчёт по остаткам',
  locale: 'ru',
  ...extra,
});
const channelOf = async (number: number) => (await pools.root.query(`select source, intake_channel from hdt_tickets where number = $1`, [number])).rows[0];

test('без поля "откуда пришло" или со значением вне перечня: invalid_input', async () => {
  const f = await seedTwoOrgs();
  await expect(createTicketForClient(staffCtx(f.l1), input(f))).rejects.toMatchObject({ code: 'invalid_input' });
  await expect(createTicketForClient(staffCtx(f.l1), input(f, { intakeChannel: 'fax' }))).rejects.toMatchObject({ code: 'invalid_input' });
  await expect(createTicketForClient(staffCtx(f.l1), input(f, { intakeChannel: '' }))).rejects.toMatchObject({ code: 'invalid_input' });
});

test('каждое значение перечня сохраняется и попадает в журнал создания', async () => {
  const f = await seedTwoOrgs();
  for (const intakeChannel of ['telegram', 'phone', 'email_direct', 'jira', 'other']) {
    const { number } = await createTicketForClient(staffCtx(f.l1), input(f, { intakeChannel }));
    expect(await channelOf(number)).toEqual({ source: 'staff', intake_channel: intakeChannel });
  }
  const audit = (await pools.root.query(`select diff from hdc_audit_log where action = 'ticket.created' and diff ->> 'source' = 'staff' order by created_on`)).rows;
  expect(audit.map((r) => r.diff.intakeChannel)).toEqual(['telegram', 'phone', 'email_direct', 'jira', 'other']);
});

test('у обращения портала поле пусто; база не принимает отметку у других источников и вне перечня', async () => {
  const f = await seedTwoOrgs();
  const { number } = await createTicket(await clientCtx(f.aUser), { type: 'question', impact: 'minor', description: 'Не открывается отчёт по остаткам', locale: 'ru' });
  expect(await channelOf(number)).toEqual({ source: 'portal', intake_channel: null });
  await expect(pools.root.query(`update hdt_tickets set intake_channel = 'telegram' where number = $1`, [number])).rejects.toThrow(/hdt_tickets_c22/);
  const staffMade = await createTicketForClient(staffCtx(f.l1), input(f, { intakeChannel: 'phone' }));
  await expect(pools.root.query(`update hdt_tickets set intake_channel = 'fax' where number = $1`, [staffMade.number])).rejects.toThrow(/hdt_tickets_c21/);
});

test('клиент не получает поле: страница обращения и список', async () => {
  const f = await seedTwoOrgs();
  const { number } = await createTicketForClient(staffCtx(f.l1), input(f, { intakeChannel: 'telegram' }));
  const ctx = await clientCtx(f.aUser);
  const page = await getTicket(ctx, number);
  expect(page).not.toBeNull();
  expect(JSON.stringify(page)).not.toMatch(/intake|telegram/i);
  const list = await listTickets(ctx, {});
  expect(JSON.stringify(list)).not.toMatch(/intake/i);
});
