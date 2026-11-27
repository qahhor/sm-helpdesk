import { afterEach, beforeEach, expect, test } from 'vitest';
import { setLogSinkForTests } from '@/lib/log';
import { handleMcpRequest } from '@/modules/hda/api/agent';
import { createProblemFromSpike, listSpikes, runSpikeDetection, saveSpikeSettings, spikeSettingsView } from '@/modules/hda/api/agent-jobs';
import { SERVICE_ORG_ID } from '@/modules/hdu/pref';
import { createMcpClient } from '../helpers/mcp-client';
import { rootWithoutTriggers, seedAgentToken } from './helpers/agent';
import { staffCtx, staffWithRole } from './helpers/auth';
import { asActor, pools } from './helpers/db';
import { type Fixture, seedTwoOrgs } from './isolation/fixture';

// Всплеск сигнатуры (веха M8b, задача 8; FR-AGT-11, 10.5; план M8b, решение 25): сигнатура у обращений не меньше чем
// трёх разных настоящих организаций за час, нет активной проблемы или черновика с ней, не было всплеска за 24 часа.

const SYSTEM = { type: 'system', job: 'test.spikes' } as const;
const SIG = 'e'.repeat(32);
let f: Fixture;
let orgC: string;

beforeEach(async () => {
  setLogSinkForTests(() => undefined);
  f = await seedTwoOrgs();
  const server = (await pools.root.query(`select server_id from hdu_servers limit 1`)).rows[0].server_id;
  orgC = (await pools.root.query(`insert into hdu_organizations (server_id, external_company_id, name) values ($1, '503', 'Initech') returning org_id`, [server])).rows[0].org_id;
});
afterEach(() => setLogSinkForTests(null));

async function ticket(orgId: string, minutesAgo = 5, signature = SIG): Promise<{ ticketId: string; number: number }> {
  const author = (await pools.root.query(`select author_id from hdt_tickets limit 1`)).rows[0].author_id;
  const row = (
    await pools.root.query(
      `insert into hdt_tickets (org_id, author_id, type, impact, priority, visibility, title, description, locale, source, error_signature)
       values ($1, $2, 'bug', 'major', 'p3', $4, 'Ошибка проведения', 'E-17', 'ru', 'portal', $3) returning ticket_id, number`,
      [orgId, author, signature, orgId === SERVICE_ORG_ID ? 'private' : 'org'],
    )
  ).rows[0];
  if (minutesAgo > 0) await rootWithoutTriggers(`update hdt_tickets set created_on = now() - make_interval(mins => $2) where ticket_id = $1`, [row.ticket_id, minutesAgo]);
  return { ticketId: row.ticket_id, number: Number(row.number) };
}
const spikes = async () => (await pools.root.query(`select signature, org_count, ticket_count, window_minutes, problem_id from hda_signature_spikes order by detected_on`)).rows;

test('три организации с одной сигнатурой за час: один всплеск; повторный обход второго не создаёт', async () => {
  await ticket(f.orgA.orgId);
  await ticket(f.orgA.orgId);
  await ticket(f.orgB.orgId);
  await ticket(orgC);
  expect(await runSpikeDetection(SYSTEM)).toEqual({ detected: 1 });
  expect(await spikes()).toEqual([{ signature: SIG, org_count: 3, ticket_count: 4, window_minutes: 60, problem_id: null }]);
  expect(await runSpikeDetection(SYSTEM)).toEqual({ detected: 0 });
  expect(await spikes()).toHaveLength(1);
});

test('две организации, одна с десятью обращениями, "Неопознанные" и обращения за окном всплеска не дают', async () => {
  for (let i = 0; i < 10; i += 1) await ticket(f.orgA.orgId);
  expect(await runSpikeDetection(SYSTEM)).toEqual({ detected: 0 });
  await ticket(f.orgB.orgId);
  await pools.root.query(`insert into hdu_organizations (org_id, name, kind) values ($1, 'Неопознанные', 'service') on conflict do nothing`, [SERVICE_ORG_ID]);
  await ticket(SERVICE_ORG_ID);
  await ticket(orgC, 90);
  expect(await runSpikeDetection(SYSTEM)).toEqual({ detected: 0 });
  expect(await spikes()).toEqual([]);
});

test('при активной проблеме или черновике с той же сигнатурой всплеска нет', async () => {
  for (const org of [f.orgA.orgId, f.orgB.orgId, orgC]) await ticket(org);
  const problem = (await pools.root.query(`insert into hdp_problems (internal_title) values ('Активная') returning problem_id`)).rows[0].problem_id;
  await pools.root.query(`insert into hdp_problem_signatures (problem_id, signature) values ($1, $2)`, [problem, SIG]);
  expect(await runSpikeDetection(SYSTEM)).toEqual({ detected: 0 });
  await pools.root.query(`update hdp_problems set status = 'closed' where problem_id = $1`, [problem]);
  const draft = (await pools.root.query(`insert into hdp_problems (internal_title, status) values ('Черновик', 'draft') returning problem_id`)).rows[0].problem_id;
  await pools.root.query(`insert into hdp_problem_signatures (problem_id, signature) values ($1, $2)`, [draft, SIG]);
  expect(await runSpikeDetection(SYSTEM)).toEqual({ detected: 0 });
  await pools.root.query(`delete from hdp_problem_signatures where problem_id = $1`, [draft]);
  expect(await runSpikeDetection(SYSTEM)).toEqual({ detected: 1 });
});

test('порог и окно: только admin со свежим входом, журнал аудита; новый порог действует со следующего обхода', async () => {
  const admin = staffCtx(f.adminStaff);
  await expect(saveSpikeSettings(staffCtx(f.l1), { orgCount: 2, windowMinutes: 60 })).rejects.toMatchObject({ code: 'forbidden' });
  await expect(saveSpikeSettings({ ...admin, freshAuthAt: new Date(Date.now() - 901e3) }, { orgCount: 2, windowMinutes: 60 })).rejects.toMatchObject({ code: 'stale_session' });
  await expect(saveSpikeSettings(admin, { orgCount: 1, windowMinutes: 60 })).rejects.toMatchObject({ code: 'invalid_input' });
  await saveSpikeSettings(admin, { orgCount: 2, windowMinutes: 30 });
  expect(await spikeSettingsView(admin)).toEqual({ orgCount: 2, windowMinutes: 30 });
  const audit = (await pools.root.query(`select diff from hdc_audit_log where action = 'settings.changed' order by created_on`)).rows.map((r) => JSON.stringify(r.diff));
  expect(audit.join()).toMatch(/agent\.spike_org_count/);
  await ticket(f.orgA.orgId);
  await ticket(f.orgB.orgId);
  expect(await runSpikeDetection(SYSTEM)).toEqual({ detected: 1 });
  expect((await spikes())[0]).toMatchObject({ org_count: 2, window_minutes: 30 });
});

test('блок "Всплески сигнатур" видят сотрудники; "Создать известную проблему" работает без агента; клиент таблицы не читает', async () => {
  const tickets = [await ticket(f.orgA.orgId), await ticket(f.orgB.orgId), await ticket(orgC)];
  await runSpikeDetection(SYSTEM);
  const list = await listSpikes(staffCtx(f.l1));
  expect(list).toEqual([expect.objectContaining({ signature: SIG, orgCount: 3, ticketCount: 3, problemNumber: null })]);
  await expect(createProblemFromSpike(staffCtx(f.l1), { spikeId: list[0]!.spikeId, internalTitle: 'Всплеск E-17' })).rejects.toMatchObject({ code: 'forbidden' });
  const l2 = staffCtx(await staffWithRole('agent_l2'));
  const { number } = await createProblemFromSpike(l2, { spikeId: list[0]!.spikeId, internalTitle: 'Всплеск E-17' });
  const problem = (await pools.root.query(`select problem_id, status, ticket_count from hdp_problems where number = $1`, [number])).rows[0];
  expect(problem).toMatchObject({ status: 'investigating', ticket_count: 3 });
  expect((await pools.root.query(`select is_active from hdp_problem_signatures where problem_id = $1`, [problem.problem_id])).rows).toEqual([{ is_active: true }]);
  expect((await listSpikes(staffCtx(f.l1)))[0]).toMatchObject({ problemNumber: number });
  expect((await pools.root.query(`select count(*)::int as n from hdt_tickets where known_problem_id = $1 and ticket_id = any($2)`, [problem.problem_id, tickets.map((t) => t.ticketId)])).rows[0].n).toBe(3);
  expect((await asActor(pools.app, f.aUser.actor, (c) => c.query(`select 1 from hda_signature_spikes`))).rowCount).toBe(0);
});

test('инструмент signature_spikes: сигнатура, числа и только видимые агенту номера обращений', async () => {
  const a = await ticket(f.orgA.orgId);
  const b = await ticket(f.orgB.orgId);
  await ticket(orgC);
  await pools.root.query(`update hdu_organizations set is_ai_enabled = false where org_id = $1`, [f.orgB.orgId]);
  await runSpikeDetection(SYSTEM);
  const token = await seedAgentToken({ tools: ['signature_spikes'] });
  const client = createMcpClient({ token: token.value, ip: '10.0.3.12', send: (request) => handleMcpRequest(request) });
  const result = await client.callTool('signature_spikes', {});
  const items = (result.structuredContent as { items: { signature: string; org_count: number; ticket_numbers: number[] }[] }).items;
  expect(items).toEqual([expect.objectContaining({ signature: SIG, org_count: 3 })]);
  expect(items[0]!.ticket_numbers).toContain(a.number);
  expect(items[0]!.ticket_numbers).not.toContain(b.number);
  expect(JSON.stringify(items)).not.toMatch(/ACME|Globex|Initech/);
});
