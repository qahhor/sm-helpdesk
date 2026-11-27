import { beforeEach, expect, test } from 'vitest';
import { processEvents } from '@/modules/hdc/api';
import { handleRuleEvent, newRuleRun } from '@/modules/hdw/api/engine';
import { dryRunRule, saveRule, setRuleEnabled } from '@/modules/hdw/api/rules';
import { staffCtx } from './helpers/auth';
import { pools } from './helpers/db';
import { type Fixture, seedTwoOrgs } from './isolation/fixture';

// Действие правила "Запросить анализ по коду" (веха M8c, задача 8; ТЗ 7.22 FR-CODE-09; план M8c, решение 22). Правило
// создаёт запрос анализа от системы с источником rule теми же проверками, что кнопка второй линии: организация с
// AI-обработкой, нет ожидающего запроса. Пробный прогон описывает действие и ничего не создаёт.

const SYSTEM = { type: 'system', job: 'automation.process' } as const;
let f: Fixture;
let admin: ReturnType<typeof staffCtx>;

beforeEach(async () => {
  f = await seedTwoOrgs();
  admin = staffCtx(f.adminStaff);
});

const definition = { name: 'Ошибка без сигнатуры', event: 'ticket_created', conditions: { match: 'all', items: [{ field: 'signature', op: 'is', value: 'absent' }] }, actions: [{ action: 'request_code_analysis' }] };
const emit = (ticketId: string, orgId: string) => pools.root.query(`insert into hdc_domain_events (org_id, ticket_id, kind) values ($1, $2, 'ticket_created')`, [orgId, ticketId]);
const drain = () => {
  const run = newRuleRun();
  return processEvents(SYSTEM, (tx, event) => handleRuleEvent(tx, event, run));
};
const requests = (ticketId: string) => pools.root.query(`select source, requested_by, status from hda_code_analysis_requests where ticket_id = $1`, [ticketId]).then((r) => r.rows);

test('правило с действием request_code_analysis создаёт запрос с источником rule и событие для AI-сотрудника; ожидающий не удваивается', async () => {
  const { ruleId } = await saveRule(admin, definition);
  await setRuleEnabled(admin, { ruleId, enabled: true });
  const t = f.tickets.aOrg;
  await emit(t.ticketId, f.orgA.orgId);
  await drain();
  expect(await requests(t.ticketId)).toEqual([{ source: 'rule', requested_by: null, status: 'pending' }]);
  expect((await pools.root.query(`select kind from hdc_domain_events where ticket_id = $1 and kind = 'code_analysis_requested'`, [t.ticketId])).rowCount).toBe(1);
  const [run] = (await pools.root.query(`select actions_done from hdw_rule_runs where rule_id = $1`, [ruleId])).rows;
  expect(run.actions_done).toEqual([{ action: 'request_code_analysis', ok: true }]);
  // Второе срабатывание, пока запрос ждёт: нового запроса нет.
  await emit(t.ticketId, f.orgA.orgId);
  await drain();
  expect((await requests(t.ticketId)).length).toBe(1);
});

test('организация без AI-обработки: итог действия ai_disabled в истории правила, запроса нет', async () => {
  const { ruleId } = await saveRule(admin, definition);
  await setRuleEnabled(admin, { ruleId, enabled: true });
  await pools.root.query(`update hdu_organizations set is_ai_enabled = false where org_id = $1`, [f.orgB.orgId]);
  await emit(f.tickets.bOrg.ticketId, f.orgB.orgId);
  await drain();
  expect(await requests(f.tickets.bOrg.ticketId)).toEqual([]);
  const [run] = (await pools.root.query(`select actions_done from hdw_rule_runs where rule_id = $1`, [ruleId])).rows;
  expect(run.actions_done).toEqual([{ action: 'request_code_analysis', ok: false, detail: 'ai_disabled' }]);
});

test('пробный прогон описывает действие и ничего не создаёт', async () => {
  const before = (await pools.root.query(`select count(*)::int as n from hda_code_analysis_requests`)).rows[0].n;
  const dry = await dryRunRule(admin, definition);
  expect(dry.count).toBeGreaterThan(0);
  expect(dry.matches[0]!.actions).toEqual([{ action: 'request_code_analysis', ok: true }]);
  expect((await pools.root.query(`select count(*)::int as n from hda_code_analysis_requests`)).rows[0].n).toBe(before);
});
