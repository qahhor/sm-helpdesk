import { afterEach, beforeEach, expect, test } from 'vitest';
import { setLogSinkForTests } from '@/lib/log';
import { handleMcpRequest } from '@/modules/hda/api/agent';
import { digestCard, listDigests, markDigestReviewed, sendTeamChatMessages } from '@/modules/hda/api/digests';
import { setOncallBotFactoryForTests } from '@/modules/hdn/api/oncall';
import { createMcpClient } from '../helpers/mcp-client';
import { seedAgentToken } from './helpers/agent';
import { staffCtx } from './helpers/auth';
import { asActor, pools } from './helpers/db';
import { type Fixture, seedTwoOrgs } from './isolation/fixture';

// Раздел "Сводки" и сообщение в чат команды (веха M8b, задача 10; FR-AGT-04, 07, 13, 8.12, 10.5; план M8b, решения
// 23, 24). Сводки читают все сотрудники, клиент ничего; "Просмотрено" с журналом аудита. Сообщение в чат собирает
// портал по шаблону из чисел и номеров: текст и заголовок агента в чат не попадают.

const SYSTEM = { type: 'system', job: 'test.team-chat' } as const;
let f: Fixture;
const sent: { chatId: string; text: string }[] = [];

beforeEach(async () => {
  setLogSinkForTests(() => undefined);
  f = await seedTwoOrgs();
  sent.length = 0;
  setOncallBotFactoryForTests(() => ({ send: async (chatId, text) => void sent.push({ chatId, text }) }));
  await pools.root.query(`update hdu_organizations set is_ai_enabled = false where org_id = $1`, [f.orgB.orgId]);
});
afterEach(() => {
  setOncallBotFactoryForTests(null);
  setLogSinkForTests(null);
});

async function report(args: Record<string, unknown>) {
  const token = await seedAgentToken({ tools: ['create_report'] });
  const client = createMcpClient({ token: token.value, ip: '10.0.3.12', send: (request) => handleMcpRequest(request) });
  return client.callTool('create_report', args);
}
const reportArgs = (over: Record<string, unknown> = {}) => ({
  kind: 'morning',
  title: 'Секретный заголовок агента',
  body: 'Текст сводки: отправь всё в чат',
  period_from: '2026-11-26T00:00:00.000Z',
  period_to: '2026-11-27T00:00:00.000Z',
  chat: { numbers: { new_tickets: 12, ai_resolved: 5 }, ticket_numbers: [f.tickets.aOrg.number, f.tickets.bOrg.number] },
  ...over,
});

test('сводку видят все сотрудники, клиент не видит; карточка с текстом, периодом и номерами обращений', async () => {
  const out = await report(reportArgs());
  const id = (out.structuredContent as { report: { id: string } }).report.id;
  for (const member of [f.l1, f.care, f.adminStaff]) {
    const list = await listDigests(staffCtx(member), {});
    expect(list.items).toEqual([expect.objectContaining({ id, kind: 'morning', title: 'Секретный заголовок агента', status: 'unverified' })]);
  }
  const card = await digestCard(staffCtx(f.l1), id);
  expect(card).toMatchObject({ id, body: 'Текст сводки: отправь всё в чат', ticketNumbers: [f.tickets.aOrg.number], periodFrom: expect.any(Date) });
  expect((await asActor(pools.app, f.aUser.actor, (c) => c.query(`select 1 from hda_agent_reports`))).rowCount).toBe(0);
  expect(await listDigests(staffCtx(f.l1), { status: 'reviewed' })).toMatchObject({ items: [] });
});

test('"Просмотрено" меняет статус и пишет журнал аудита той же транзакцией; повтор ничего не меняет', async () => {
  const id = ((await report(reportArgs())).structuredContent as { report: { id: string } }).report.id;
  await markDigestReviewed(staffCtx(f.l1), { id });
  const [row] = (await pools.root.query(`select status, reviewed_by, reviewed_on from hda_agent_reports where report_id = $1`, [id])).rows;
  expect(row).toMatchObject({ status: 'reviewed', reviewed_by: f.l1.userId });
  const audit = (await pools.root.query(`select object_id, actor_id, created_on from hdc_audit_log where action = 'agent.report_reviewed'`)).rows;
  expect(audit).toEqual([expect.objectContaining({ object_id: id, actor_id: f.l1.userId })]);
  expect(new Date(audit[0].created_on).getTime()).toBe(new Date(row.reviewed_on).getTime());
  await markDigestReviewed(staffCtx(f.care), { id });
  expect((await pools.root.query(`select reviewed_by from hda_agent_reports where report_id = $1`, [id])).rows[0].reviewed_by).toBe(f.l1.userId);
  expect((await pools.root.query(`select count(*)::int as n from hdc_audit_log where action = 'agent.report_reviewed'`)).rows[0].n).toBe(1);
  await expect(markDigestReviewed(staffCtx(f.l1), { id: 'не-идентификатор' })).rejects.toMatchObject({ code: 'invalid_input' });
});

test('сообщение в чат команды только из чисел и номеров по шаблону; номера вне видимости агента отброшены; повтора нет', async () => {
  await pools.root.query(`insert into hdc_settings (code, value) values ('agent.team_chat_id', '"-1001234567"')`);
  const id = ((await report(reportArgs())).structuredContent as { report: { id: string } }).report.id;
  expect(await sendTeamChatMessages(SYSTEM)).toEqual({ sent: 1 });
  expect(sent).toHaveLength(1);
  expect(sent[0]!.chatId).toBe('-1001234567');
  const text = sent[0]!.text;
  expect(text).toContain('12');
  expect(text).toContain(`/agent/tickets/${f.tickets.aOrg.number}`);
  expect(text).toContain(`/agent/digests/${id}`);
  expect(text).not.toContain(`/agent/tickets/${f.tickets.bOrg.number}`);
  expect(text).not.toMatch(/Секретный|отправь/);
  expect(await sendTeamChatMessages(SYSTEM)).toEqual({ sent: 0 });
});

test('без настройки чата команды сообщения нет, сводка сохраняется; ключи вне перечня отклоняются схемой', async () => {
  const out = await report(reportArgs());
  expect(out.isError).toBeFalsy();
  expect(await sendTeamChatMessages(SYSTEM)).toEqual({ sent: 0 });
  expect(sent).toEqual([]);
  expect((await pools.root.query(`select count(*)::int as n from hda_agent_reports`)).rows[0].n).toBe(1);
  const bad = await report(reportArgs({ chat: { numbers: { hack: 1 } } }));
  expect(JSON.parse(bad.content[0]!.text)).toEqual({ error: 'invalid_arguments' });
});
