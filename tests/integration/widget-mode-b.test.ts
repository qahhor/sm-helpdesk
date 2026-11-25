import { afterEach, beforeEach, expect, test } from 'vitest';
import { MemoryJobQueue, MemoryStorage, setJobQueueForTests, setStorageForTests } from '@/modules/hdc/testing';
import { ticketErrorSignature } from '@/modules/hdk/signature';
import { createTicket, getMetrics } from '@/modules/hdt/api';
import { clientCtx, staffCtx, staffWithRole } from './helpers/auth';
import { pools } from './helpers/db';
import { type Fixture, seedTwoOrgs } from './isolation/fixture';

// Режим B виджета и каналы показателей (план M6, задача 8; FR-WG-04, FR-MET-03, FR-MET-10; решения 11 и 12).
// Форма портала, открытая из загрузчика с признаком виджета, создаёт обращение с источником widget_web и контекстом
// из подсказок. Признак влияет только на показатели: организация и автор, как всегда, из актора.

let f: Fixture;
beforeEach(async () => {
  f = await seedTwoOrgs();
  setStorageForTests(new MemoryStorage());
  setJobQueueForTests(new MemoryJobQueue());
});
afterEach(() => {
  setStorageForTests(null);
  setJobQueueForTests(null);
});

const base = { description: 'ORA-20001: Нет доступа к складу', type: 'bug', impact: 'major', locale: 'ru' };
const context = { moduleCode: 'orders', screen: 'order_edit', version: '5.12.0', errorCode: 'ORA-20001', errorText: 'Нет доступа к складу' };

async function row(number: number) {
  const { rows } = await pools.root.query<{ source: string; context: Record<string, string> | null; error_signature: string | null; org_id: string; author_id: string }>(
    `select source, context, error_signature, org_id, author_id from hdt_tickets where number = $1`,
    [number],
  );
  return rows[0];
}

test('обращение режима B учитывается как виджет: источник widget_web, контекст из подсказок, сигнатура по ошибке', async () => {
  const client = await clientCtx(f.aUser);
  const { number } = await createTicket(client, { ...base, widget: '1', context: JSON.stringify(context), orgId: f.orgB.orgId });
  const saved = await row(number);
  expect(saved).toMatchObject({ source: 'widget_web', context, org_id: f.orgA.orgId, author_id: f.aUser.userId });
  // Платформу знает только проверенный токен: у режима B её нет.
  expect(saved?.context).not.toHaveProperty('platform');
  // Та же ошибка из панели виджета даёт ту же сигнатуру: точное совпадение работает в обоих режимах.
  expect(saved?.error_signature).toBe(ticketErrorSignature({ context: { errorCode: 'ORA-20001', errorText: 'Нет доступа к складу' }, description: base.description })?.signature);
});

test('без признака виджета: портал, контекст отбрасывается; неверный контекст не мешает обращению', async () => {
  const client = await clientCtx(f.aUser);
  const portal = await createTicket(client, { ...base, context: JSON.stringify(context) });
  expect(await row(portal.number)).toMatchObject({ source: 'portal', context: null });
  // Неверная подсказка отбрасывается (решение 11), обращение всё равно создаётся как виджет.
  const broken = await createTicket(client, { ...base, widget: '1', context: '{not json' });
  expect(await row(broken.number)).toMatchObject({ source: 'widget_web', context: null });
  const partly = await createTicket(client, { ...base, widget: '1', context: JSON.stringify({ moduleCode: 'orders<script>', errorCode: 'E1', platform: 'android' }) });
  expect(await row(partly.number)).toMatchObject({ source: 'widget_web', context: { errorCode: 'E1' } });
});

test('каналы показателей: портал, виджет (Web и приложение), почта и сотрудник отдельно (FR-MET-10)', async () => {
  // Триггеры ставят дату создания сами: набор в прошлой неделе пишется без них, как в metrics.test.ts.
  const db = await pools.root.connect();
  try {
    await db.query(`set session_replication_role = replica`);
    await db.query(
      `insert into hdt_tickets (org_id, author_id, type, impact, priority, visibility, title, description, locale, source, status, created_on, modified_on, resolved_on)
       select $1, $2, 'question', 'minor', 'p3', 'org', 'Канал ' || s, 'Текст', 'ru', s, case when n = 1 then 'resolved' else 'new' end,
              '2026-11-03T05:00:00Z', '2026-11-03T05:00:00Z', case when n = 1 then '2026-11-03T07:00:00Z'::timestamptz end
         from unnest(array['portal','portal','portal','widget_web','widget_web','widget_mobile','email','staff']) with ordinality as x(s, n)`,
      [f.orgA.orgId, f.aUser.userId],
    );
  } finally {
    await db.query(`set session_replication_role = origin`).catch(() => undefined);
    db.release();
  }
  // Отдельная неделя в прошлом: обращения набора seedTwoOrgs созданы сейчас и в неё не попадают.
  const view = await getMetrics(staffCtx(await staffWithRole('agent_l1')), { period: 'custom', from: '2026-11-02', to: '2026-11-08' }, new Date('2026-11-20T10:00:00Z'));
  expect(view.channels.map(({ channel, count, percent, resolved }) => ({ channel, count, percent, resolved }))).toEqual([
    { channel: 'portal', count: 3, percent: 37.5, resolved: 1 },
    { channel: 'widget', count: 3, percent: 37.5, resolved: 0 },
    { channel: 'email', count: 1, percent: 12.5, resolved: 0 },
    { channel: 'staff', count: 1, percent: 12.5, resolved: 0 },
  ]);
  // Подробные источники остаются: Web и приложение отдельно (FR-MET-03).
  expect(view.sources.map((s) => [s.source, s.count])).toEqual([
    ['portal', 3],
    ['widget_web', 2],
    ['email', 1],
    ['staff', 1],
    ['widget_mobile', 1],
  ]);
});
