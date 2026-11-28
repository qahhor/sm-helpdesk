import { expect, test } from '@playwright/test';
import { callOk, e2eMcpClient, seedAgentForE2e } from './helpers/agent';
import { signInAsCustom, uniqueSub } from './helpers/client';
import { dbRows } from './helpers/db';
import { signInStaff, staffAccount } from './helpers/staff';

// Сценарий 19 раздела 15.3 и строка приёмки M8b раздела 16.2 (план M8b, задача 11): тестовый клиент MCP по HTTP читает
// обращение без контактов и оставляет внутреннюю заметку; клиент её не видит, сотрудник видит с пометкой. Вызов
// инструмента вне перечня отклоняется, после отзыва токена следующий запрос отклонён сразу.

test.beforeEach(({}, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'сценарий проверяется на ноутбуке');
});
test.use({ storageState: { cookies: [], origins: [] } });

test('сценарий 19: агент через сервер MCP читает обращение без контактов и оставляет заметку, клиент её не видит', async ({ browser }) => {
  test.setTimeout(240_000);
  const clientPage = await (await browser.newContext()).newPage();
  const name = `Шахзода ${uniqueSub()}`;
  await signInAsCustom(clientPage, { sub: uniqueSub(), name, company_id: '501', company_name: 'ACME Trade' });
  const [member] = await dbRows<{ user_id: string; org_id: string }>(
    `select m.user_id, m.org_id from hdu_memberships m join auth."user" u on u.id = m.user_id where u.name = $1 limit 1`,
    [name],
  );
  // Агент видит только организации с AI-обработкой; новая организация получает её только отметкой согласия (план M9, решение 10).
  await dbRows(`update hdu_organizations set is_ai_enabled = true, ai_consent_on = current_date, ai_consent_ref = 'Тестовое согласие ' || clock_timestamp()::text where org_id = $1`, [member!.org_id]);
  const firstName = name.split(' ')[0]!;
  const [ticket] = await dbRows<{ number: string }>(
    `insert into hdt_tickets (org_id, author_id, type, impact, priority, visibility, title, description, locale, source)
     values ($1, $2, 'bug', 'major', 'p3', 'org', $3, $4, 'ru', 'portal') returning number`,
    [member!.org_id, member!.user_id, `${firstName} из ACME Trade: отчёт не грузится`, `Звоните ${firstName} +998 90 555 44 33, почта shahzoda@acme.uz`],
  );
  const number = Number(ticket!.number);

  const agent = await seedAgentForE2e(['get_ticket', 'add_internal_note']);
  const mcp = e2eMcpClient(agent.value);
  const init = await mcp.initialize();
  expect(init.serverInfo.name).toBe('smartup-hub');
  expect((await mcp.listTools()).map((tool) => tool.name)).toEqual(['get_ticket', 'add_internal_note']);

  // Чтение без контактов: ни имени, ни телефона, ни почты, ни названия организации.
  const read = await callOk(mcp, 'get_ticket', { number });
  const text = JSON.stringify(read);
  for (const secret of [firstName, '555 44 33', 'shahzoda@acme.uz', 'ACME']) expect(text, secret).not.toContain(secret);
  expect(read.ticket).toMatchObject({ number, untrusted_customer_text: { title: expect.stringContaining('[организация]') } });

  const note = `Заметка сценария 19 ${uniqueSub()}`;
  await callOk(mcp, 'add_internal_note', { ticket_number: number, body: note });

  // Вызов вне перечня отклоняется и записан в журнал.
  const refused = await mcp.callTool('search_tickets', {});
  expect(refused.isError).toBe(true);
  expect(JSON.parse(refused.content[0]!.text)).toEqual({ error: 'tool_not_allowed' });
  expect(await dbRows(`select status from hda_agent_tool_calls where token_id = $1 and tool = 'search_tickets'`, [agent.tokenId])).toEqual([{ status: 'refused' }]);

  // Клиент не видит заметку.
  await clientPage.goto(`/ru/tickets/${number}`);
  await expect(clientPage.getByRole('main')).toContainText('отчёт не грузится');
  await expect(clientPage.getByRole('main')).not.toContainText(note);

  // Сотрудник видит заметку с пометкой.
  const staffPage = await (await browser.newContext()).newPage();
  await signInStaff(staffPage, staffAccount('l1'));
  await staffPage.goto(`/ru/agent/tickets/${number}`);
  const entry = staffPage.getByRole('main').locator('article', { hasText: note });
  await expect(entry.locator('[data-agent-mark]')).toHaveText('AI-сотрудник, не проверено');

  // Отзыв: следующий запрос отклонён сразу.
  await dbRows(`update hda_agent_tokens set revoked_at = now() where token_id = $1`, [agent.tokenId]);
  expect((await mcp.rpc('tools/list')).status).toBe(401);
});
