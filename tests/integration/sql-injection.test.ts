import { expect, test } from 'vitest';
import { listTemplates, saveTemplate } from '@/modules/hdr/api';
import { getTicket, listQueue, listTickets, replyToTicket } from '@/modules/hdt/api';
import { searchOrganizations } from '@/modules/hdu/api';
import { clientCtx, staffCtx } from './helpers/auth';
import { pools } from './helpers/db';
import { seedTwoOrgs } from './isolation/fixture';

// Защита от SQL-инъекций (ТЗ 14.3, V2 ASVS): ввод доходит до базы только параметром. Строки атак в полях поиска
// и текста не меняют запрос: ничего не удаляется, чужое не находится, ошибки базы нет.

const PAYLOADS = [
  "' or '1'='1",
  "'; drop table hdt_tickets; --",
  "1; update hdt_tickets set org_id = null; --",
  "%' union select ticket_id, title from hdt_tickets --",
  '\\%_\\',
  "SUP-1' or 1=1 --",
  '$1',
];

const counts = async () =>
  (await pools.root.query(`select (select count(*)::int from hdt_tickets) as tickets, (select count(*)::int from hdu_organizations) as orgs`)).rows[0];

test('строки атак в поиске клиента, очереди сотрудника, поиске организаций и шаблонов не меняют запрос', async () => {
  const f = await seedTwoOrgs();
  const before = await counts();
  const client = await clientCtx(f.aUser);
  const l1 = staffCtx(f.l1);
  for (const q of PAYLOADS) {
    const mine = await listTickets(client, { q });
    // Клиент организации А не находит обращения организации Б ни при каком тексте.
    expect(JSON.stringify(mine)).not.toContain('Секрет Б');
    expect((await listQueue(l1, { queue: 'all', q })).items.length).toBeLessThanOrEqual(1);
    expect((await searchOrganizations(l1, { query: q })).items).toEqual([]);
    expect(await listTemplates(l1, { q })).toEqual([]);
  }
  expect(await counts()).toEqual(before);
});

test('строка атаки в тексте сохраняется как текст и возвращается без изменений', async () => {
  const f = await seedTwoOrgs();
  const client = await clientCtx(f.aUser);
  const body = "Robert'); drop table hdt_ticket_messages; -- и %_ знаки";
  await replyToTicket(client, { number: f.tickets.aOrg.number, body });
  expect((await getTicket(client, f.tickets.aOrg.number))?.messages.map((m) => m.body)).toContain(body);
  await saveTemplate(staffCtx(f.adminStaff), { shortcut: 'safe', title: "'; drop table hdr_reply_templates; --", body: { ru: "' or '1'='1" }, moduleId: null, isEnabled: true });
  expect((await listTemplates(staffCtx(f.l1), {})).map((t) => [t.title, t.body.ru])).toEqual([["'; drop table hdr_reply_templates; --", "' or '1'='1"]]);
});
