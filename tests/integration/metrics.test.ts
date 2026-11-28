import { beforeEach, describe, expect, test } from 'vitest';
import { RATE_RULES } from '@/modules/hdc/pref';
import { buildCsv, exportMetrics, getAgentTicket, getMetrics, getMetricsBreakdown, getTicket, listTickets, saveCsatReview } from '@/modules/hdt/api';
import type { StaffContext } from '@/modules/hdu/api';
import { clientCtx, staffCtx, staffWithRole } from './helpers/auth';
import { captureQueries, plansFor, seedBulkTickets } from './helpers/bulk';
import { asActor, pools } from './helpers/db';
import { type Fixture, seedTwoOrgs } from './isolation/fixture';
import { expectWithin } from './helpers/timing';

// Показатели поддержки (FR-MET-01, 03, 04, 07, 10, FR-LINE-08; план M8, задача 9, решения 14-16; пункты 6 и 7
// раздела "На что смотреть"). Набор из 200 обращений с известными ответами: времена заданы явно, ожидаемые числа
// посчитаны вручную и записаны рядом с набором. Каждый блок страницы сверяется с ними.

let f: Fixture;
beforeEach(async () => {
  f = await seedTwoOrgs();
});

// Период набора: неделя со 2 по 8 ноября 2026 по Ташкенту. "Сейчас" для расчёта: 20 ноября.
const NOW = new Date('2026-11-20T10:00:00Z');
const WEEK = { period: 'custom', from: '2026-11-02', to: '2026-11-08' };
const at = (day: string, time: string) => `2026-11-${day}T${time}:00Z`;

type Row = {
  title: string;
  org: 'a' | 'b';
  source: string;
  module: 'm1' | 'm2' | null;
  status: string;
  queue: string;
  created: string;
  responded?: string;
  resolved?: string;
  closed?: string;
  frDue?: string;
  frBreached?: string;
  resDue?: string;
  resBreached?: string;
  pausedOn?: string;
  pausedMinutes?: number;
  score?: number;
  reason?: string;
  comment?: string;
  merged?: boolean;
  assigned?: boolean;
};
type Event = { title: string; kind: 'queue' | 'status'; payload: Record<string, unknown>; at: string };

/**
 * Набор из 200 обращений. Рабочее время по умолчанию: Пн-Пт 08:00-20:00 по Ташкенту, то есть 03:00-15:00 UTC.
 *
 * А, 1-80: организация А, портал, модуль 1. Создано во вторник 03.11 в 05:00, ответ в 05:30 (30 минут), решено
 *   в 07:00 (120 минут) на первой линии. 1-40 закрыты, 41-80 решены. Оценки: 1-10 пять, 11-20 четыре, 21-25 два.
 * Б, 81-120: организация А, почта, модуль 2. Создано в среду 04.11 в 04:00, передано на вторую линию в 05:00, ответ
 *   в 06:00 (120 минут, срок первого ответа нарушен), решено в четверг в 04:00: 720 рабочих минут, из них 120 на паузе,
 *   время решения 600. На первой линии 60 минут, на второй 660. Срок решения нарушен у 81-90. Закрыты.
 *   Оценки: 81-85 один, 86-90 три, 91-100 пять.
 * В, 121-140: организация Б, создал сотрудник, без модуля. Создано в четверг 05.11 в 04:00, ответ в 04:10 (10 минут),
 *   на вторую линию в 04:30 (правилом), возврат в 05:00, снова на вторую в 05:30, "В разработке" в 06:00, решено
 *   в 10:00 (360 минут). Первая линия 60 минут, вторая 60, разработка 240. Решены, возвратов 20.
 * Г, 141-170: организация Б, портал, модуль 1. Создано в пятницу 06.11 в 05:00, ответ в 05:20 (20 минут), не решены.
 *   Срок решения прошёл 10.11: у 141-150 стоит отметка нарушения, у 151-160 нет, 161-170 ждут клиента (пауза).
 * Д, 171-190: организация Б, почта, модуль 2. Создано в субботу 07.11 в 05:00, ответа нет. У 171-180 срок первого
 *   ответа нарушен, у 181-190 он ещё не наступил.
 * Е, 191-200: организация А, портал, модуль 1. Создано в воскресенье 08.11 в 18:59 (последняя минута периода).
 *   Объединённые дубли: закрыты объединением.
 * Вне периода: 201 создано за секунду до начала, 202 ровно в конце периода (граница не входит); оба с оценкой 1.
 */
function dataset(): { rows: Row[]; events: Event[] } {
  const rows: Row[] = [];
  const events: Event[] = [];
  for (let g = 1; g <= 200; g += 1) {
    const title = `M-${g}`;
    if (g <= 80) {
      rows.push({
        title, org: 'a', source: 'portal', module: 'm1', queue: 'l1', status: g <= 40 ? 'closed' : 'resolved',
        created: at('03', '05:00'), responded: at('03', '05:30'), resolved: at('03', '07:00'), closed: g <= 40 ? at('03', '08:00') : undefined,
        frDue: at('03', '09:00'), resDue: at('05', '05:00'), pausedOn: at('03', '07:00'),
        score: g <= 10 ? 5 : g <= 20 ? 4 : g <= 25 ? 2 : undefined, reason: g > 20 && g <= 25 ? 'slow' : undefined, assigned: true,
      });
      events.push({ title, kind: 'status', payload: { from: 'new', to: 'in_progress' }, at: at('03', '05:30') }, { title, kind: 'status', payload: { from: 'in_progress', to: 'resolved' }, at: at('03', '07:00') });
    } else if (g <= 120) {
      rows.push({
        title, org: 'a', source: 'email', module: 'm2', queue: 'l2', status: 'closed',
        created: at('04', '04:00'), responded: at('04', '06:00'), resolved: at('05', '04:00'), closed: at('05', '05:00'),
        frDue: at('04', '05:00'), frBreached: at('04', '05:00'), resDue: at('05', '03:30'), resBreached: g <= 90 ? at('05', '03:30') : undefined,
        pausedOn: at('05', '04:00'), pausedMinutes: 120,
        score: g <= 85 ? 1 : g <= 90 ? 3 : g <= 100 ? 5 : undefined, reason: g <= 85 ? 'not_solved' : g <= 90 ? 'other' : undefined,
        comment: g <= 85 ? `Так и не решили ${g}` : undefined, assigned: true,
      });
      events.push(
        { title, kind: 'queue', payload: { from: 'l1', to: 'l2', reason: 'suspected_bug' }, at: at('04', '05:00') },
        { title, kind: 'status', payload: { from: 'new', to: 'in_progress' }, at: at('04', '06:00') },
        { title, kind: 'status', payload: { from: 'in_progress', to: 'resolved' }, at: at('05', '04:00') },
        { title, kind: 'status', payload: { from: 'resolved', to: 'closed' }, at: at('05', '05:00') },
      );
    } else if (g <= 140) {
      rows.push({
        title, org: 'b', source: 'staff', module: null, queue: 'l2', status: 'resolved',
        created: at('05', '04:00'), responded: at('05', '04:10'), resolved: at('05', '10:00'), frDue: at('05', '08:00'), resDue: at('09', '04:00'), pausedOn: at('05', '10:00'),
      });
      events.push(
        { title, kind: 'status', payload: { from: 'new', to: 'in_progress' }, at: at('05', '04:10') },
        // Передачу правилом записывает правило: прежняя очередь в поле was.
        { title, kind: 'queue', payload: { was: 'l1', to: 'l2', byRule: true }, at: at('05', '04:30') },
        { title, kind: 'queue', payload: { from: 'l2', to: 'l1', explanation: 'Нужны данные' }, at: at('05', '05:00') },
        { title, kind: 'queue', payload: { from: 'l1', to: 'l2', reason: 'suspected_bug' }, at: at('05', '05:30') },
        { title, kind: 'status', payload: { from: 'in_progress', to: 'in_development' }, at: at('05', '06:00') },
        { title, kind: 'status', payload: { from: 'in_development', to: 'resolved' }, at: at('05', '10:00') },
      );
    } else if (g <= 170) {
      const waiting = g > 160;
      rows.push({
        title, org: 'b', source: 'portal', module: 'm1', queue: 'l1', status: waiting ? 'waiting_customer' : 'in_progress',
        created: at('06', '05:00'), responded: at('06', '05:20'), frDue: at('06', '09:00'), resDue: at('10', '05:00'),
        resBreached: g <= 150 ? at('10', '05:00') : undefined, pausedOn: waiting ? at('06', '06:00') : undefined,
      });
    } else if (g <= 190) {
      rows.push({
        title, org: 'b', source: 'email', module: 'm2', queue: 'l1', status: 'new',
        created: at('07', '05:00'), frDue: g <= 180 ? at('07', '06:00') : '2026-12-01T05:00:00Z', frBreached: g <= 180 ? at('07', '06:00') : undefined, resDue: '2026-12-01T05:00:00Z',
      });
    } else {
      rows.push({
        title, org: 'a', source: 'portal', module: 'm1', queue: 'l1', status: 'closed', merged: true,
        created: at('08', '18:59'), resolved: at('08', '18:59'), closed: at('08', '18:59'), pausedOn: at('08', '18:59'),
      });
    }
  }
  rows.push(
    { title: 'M-201', org: 'a', source: 'portal', module: 'm1', queue: 'l1', status: 'closed', created: '2026-11-01T18:59:59Z', responded: at('02', '05:00'), resolved: at('02', '06:00'), closed: at('02', '07:00'), pausedOn: at('02', '06:00'), score: 1, reason: 'slow' },
    { title: 'M-202', org: 'a', source: 'portal', module: 'm1', queue: 'l1', status: 'closed', created: at('08', '19:00'), responded: at('09', '05:00'), resolved: at('09', '06:00'), closed: at('09', '07:00'), pausedOn: at('09', '06:00'), score: 1, reason: 'slow' },
  );
  return { rows, events };
}

type Seeded = { m1: string; m2: string; number: (g: number) => number; id: (g: number) => string };

/** Заливает набор под суперпользователем без триггеров: дата создания и события ставятся как задано. */
async function seedMetrics(): Promise<Seeded> {
  const { rows, events } = dataset();
  const modules = (await pools.root.query(`insert into hdr_product_modules (code, name) values ('orders', '{"ru": "Заказы", "en": "Orders"}'), ('stock', '{"ru": "Склад"}') returning module_id, code`)).rows;
  const m1 = modules.find((m) => m.code === 'orders').module_id as string;
  const m2 = modules.find((m) => m.code === 'stock').module_id as string;
  const records = rows.map((row) => ({
    title: row.title,
    org_id: row.org === 'a' ? f.orgA.orgId : f.orgB.orgId,
    author_id: row.org === 'a' ? f.aUser.userId : f.bUser.userId,
    source: row.source,
    module_id: row.module === 'm1' ? m1 : row.module === 'm2' ? m2 : null,
    status: row.status,
    queue: row.queue,
    assignee_id: row.assigned ? f.l1.userId : null,
    created_on: row.created,
    first_responded_on: row.responded ?? null,
    resolved_on: row.resolved ?? null,
    closed_on: row.closed ?? null,
    first_response_due_on: row.frDue ?? null,
    first_response_breached_on: row.frBreached ?? null,
    resolution_due_on: row.resDue ?? null,
    resolution_breached_on: row.resBreached ?? null,
    sla_paused_on: row.pausedOn ?? null,
    sla_paused_minutes: row.pausedMinutes ?? 0,
    csat_score: row.score ?? null,
    csat_reason: row.reason ?? null,
    csat_comment: row.comment ?? null,
    merged_into_id: row.merged ? f.tickets.aOrg.ticketId : null,
  }));
  const client = await pools.root.connect();
  try {
    await client.query(`set session_replication_role = replica`);
    await client.query(
      `insert into hdt_tickets (org_id, author_id, type, impact, priority, visibility, title, description, locale, source, status, queue, module_id, assignee_id,
                                created_on, modified_on, first_responded_on, resolved_on, closed_on, first_response_due_on, first_response_breached_on,
                                resolution_due_on, resolution_breached_on, sla_paused_on, sla_paused_minutes, csat_score, csat_reason, csat_comment, merged_into_id)
       select x.org_id, x.author_id, 'question', 'minor', 'p3', 'org', x.title, 'Тайное описание обращения', 'ru', x.source, x.status, x.queue, x.module_id, x.assignee_id,
              x.created_on, x.created_on, x.first_responded_on, x.resolved_on, x.closed_on, x.first_response_due_on, x.first_response_breached_on,
              x.resolution_due_on, x.resolution_breached_on, x.sla_paused_on, x.sla_paused_minutes, x.csat_score, x.csat_reason, x.csat_comment, x.merged_into_id
         from jsonb_to_recordset($1::jsonb) as x(title text, org_id uuid, author_id uuid, source text, module_id uuid, status text, queue text, assignee_id uuid,
              created_on timestamptz, first_responded_on timestamptz, resolved_on timestamptz, closed_on timestamptz, first_response_due_on timestamptz,
              first_response_breached_on timestamptz, resolution_due_on timestamptz, resolution_breached_on timestamptz, sla_paused_on timestamptz,
              sla_paused_minutes int, csat_score smallint, csat_reason text, csat_comment text, merged_into_id uuid)`,
      [JSON.stringify(records)],
    );
    await client.query(
      `insert into hdt_ticket_events (org_id, ticket_id, kind, actor_type, payload, is_internal, created_on, modified_on)
       select t.org_id, t.ticket_id, x.kind, 'staff', x.payload, true, x.at, x.at
         from jsonb_to_recordset($1::jsonb) as x(title text, kind text, payload jsonb, at timestamptz) join hdt_tickets t on t.title = x.title`,
      [JSON.stringify(events)],
    );
  } finally {
    await client.query(`set session_replication_role = origin`).catch(() => undefined);
    client.release();
  }
  const found = (await pools.root.query(`select title, number, ticket_id from hdt_tickets where title like 'M-%'`)).rows;
  const byTitle = new Map(found.map((row) => [row.title as string, row]));
  return { m1, m2, number: (g) => Number(byTitle.get(`M-${g}`).number), id: (g) => byTitle.get(`M-${g}`).ticket_id as string };
}

const audit = (action: string) =>
  pools.root.query(`select actor_id, object_type, object_id, org_id, diff from hdc_audit_log where action = $1 order by created_on, audit_id`, [action]).then((r) => r.rows);
const lead = (member: { userId: string; name: string; actor: StaffContext['actor'] }): StaffContext => ({ ...staffCtx(member), isLead: true });

test('сводка сходится с ручным пересчётом на наборе из 200 обращений', async () => {
  await seedMetrics();
  const view = await getMetrics(staffCtx(f.l1), WEEK, NOW);
  expect(view.period).toMatchObject({ preset: 'custom', fromDay: '2026-11-02', toDay: '2026-11-08', days: 7 });
  expect(view.timeZone).toBe('Asia/Tashkent');
  expect(view.capped).toBe(false);
  const o = view.overview;
  // Создано 200. Решено: А 80, Б 40, В 20. Закрыто: А 40, Б 40; дубли Е не считаются.
  expect([o.created, o.resolved, o.closed]).toEqual([200, 140, 80]);
  // Завершено за период, когда бы ни создано: решены в периоде А 80, Б 40, В 20 и обращение 201 (создано до периода,
  // решено 02.11). Дубли Е закрыты объединением и не считаются; 202 решено 09.11, после периода. 141.
  expect(o.finished).toBe(141);
  // Первый ответ: исход известен у А 80, Б 40, В 20, Г 30 и у Д 171-180; нарушен у Б 40 и Д 10. 130 из 180.
  expect(o.firstResponse).toEqual({ total: 180, ok: 130, percent: 72.2 });
  // Решение: А 80, Б 40, В 20, Г 141-160 (у 161-170 пауза, у Д срок не наступил); нарушен у Б 10 и Г 10. 140 из 160.
  expect(o.resolution).toEqual({ total: 160, ok: 140, percent: 87.5 });
  // Время первого ответа: В 20 по 10, Г 30 по 20, А 80 по 30, Б 40 по 120. Сумма 8000 на 170, медиана 30.
  expect(o.firstResponseTime.count).toBe(170);
  expect(o.firstResponseTime.averageMinutes).toBeCloseTo(8000 / 170, 6);
  expect(o.firstResponseTime.medianMinutes).toBe(30);
  // Время решения: А 80 по 120, В 20 по 360, Б 40 по 600 (720 минус 120 на паузе). Сумма 40800 на 140, медиана 120.
  expect(o.resolutionTime.count).toBe(140);
  expect(o.resolutionTime.averageMinutes).toBeCloseTo(40800 / 140, 6);
  expect(o.resolutionTime.medianMinutes).toBe(120);
  // Оценки: 10 пятёрок, 10 четвёрок и 5 двоек у А; 5 единиц, 5 троек и 10 пятёрок у Б. 45 оценок, сумма 170, 30 высоких.
  expect(o.csat.count).toBe(45);
  expect(o.csat.average).toBeCloseTo(170 / 45, 6);
  expect(o.csat.highPercent).toBe(66.7);
});

test('завершено за период: по дате решения, а без решения по дате закрытия; открытое заново и дубли не считаются', async () => {
  // Четыре обращения вне набора, все созданы задолго до периода. Времена ставятся без триггеров.
  const make = async (title: string, set: string) => {
    const client = await pools.root.connect();
    try {
      await client.query(`set session_replication_role = replica`);
      await client.query(
        `insert into hdt_tickets (org_id, author_id, type, impact, priority, visibility, title, description, locale, source, created_on, modified_on)
         values ($1, $2, 'question', 'minor', 'p3', 'org', $3, 'Текст', 'ru', 'portal', '2026-09-01T05:00:00Z', '2026-09-01T05:00:00Z')`,
        [f.orgA.orgId, f.aUser.userId, title],
      );
      await client.query(`update hdt_tickets set ${set} where title = $1`, [title]);
    } finally {
      await client.query(`set session_replication_role = origin`).catch(() => undefined);
      client.release();
    }
  };
  // Закрыто без решения в периоде (автозакрытие из ожидания): считается по дате закрытия.
  await make('F-1', `status = 'closed', closed_on = '${at('04', '06:00')}'`);
  // Решено до периода, закрыто в периоде: завершено в день решения, в период не входит.
  await make('F-2', `status = 'closed', resolved_on = '2026-10-30T06:00:00Z', closed_on = '${at('04', '06:00')}'`);
  // Решено в периоде и открыто заново: сейчас не завершено.
  await make('F-3', `status = 'in_progress', resolved_on = '${at('05', '06:00')}'`);
  // Дубль, закрытый объединением в периоде.
  await make('F-4', `status = 'closed', resolved_on = '${at('05', '06:00')}', closed_on = '${at('05', '06:00')}', merged_into_id = '${f.tickets.aOrg.ticketId}'`);
  // Решено в первую и в последнюю секунду периода: обе входят; ровно в конце периода не входит.
  await make('F-5', `status = 'resolved', resolved_on = '2026-11-01T19:00:00Z'`);
  await make('F-6', `status = 'resolved', resolved_on = '2026-11-08T18:59:59Z'`);
  await make('F-7', `status = 'resolved', resolved_on = '2026-11-08T19:00:00Z'`);
  const view = await getMetrics(staffCtx(f.l1), WEEK, NOW);
  // Созданных в периоде нет, завершённых три: F-1, F-5, F-6.
  expect([view.overview.created, view.overview.finished]).toEqual([0, 3]);
});

test('решено и открыто заново: дата решения остаётся в обращении, но в "решено", в "завершено" и во время решения оно не входит (проверка M8, m8)', async () => {
  // Дата решения при повторном открытии не очищается (так устроено действие клиента и сотрудника): счётчики
  // опираются на текущий статус. Два обращения созданы и решены в периоде; второе клиент открыл заново.
  const make = async (title: string, status: string) => {
    const client = await pools.root.connect();
    try {
      await client.query(`set session_replication_role = replica`);
      await client.query(
        `insert into hdt_tickets (org_id, author_id, type, impact, priority, visibility, title, description, locale, source, status, created_on, modified_on, first_responded_on, resolved_on, resolution_due_on)
         values ($1, $2, 'question', 'minor', 'p3', 'org', $3, 'Текст', 'ru', 'portal', $4, '${at('03', '05:00')}', '${at('03', '05:00')}', '${at('03', '05:30')}', '${at('03', '07:00')}', '2026-12-30T05:00:00Z')`,
        [f.orgA.orgId, f.aUser.userId, title, status],
      );
    } finally {
      await client.query(`set session_replication_role = origin`).catch(() => undefined);
      client.release();
    }
  };
  await make('R-1', 'resolved');
  await make('R-2', 'in_progress');
  const reopened = (await pools.root.query(`select status, resolved_on from hdt_tickets where title = 'R-2'`)).rows[0];
  expect([reopened.status, reopened.resolved_on !== null]).toEqual(['in_progress', true]);
  const view = await getMetrics(staffCtx(f.l1), WEEK, NOW);
  // Создано два, решено и завершено одно; время решения считается по одному обращению (120 рабочих минут).
  expect([view.overview.created, view.overview.resolved, view.overview.finished]).toEqual([2, 1, 1]);
  expect(view.overview.resolutionTime).toMatchObject({ count: 1, averageMinutes: 120 });
  // Срок решения у открытого заново ещё не вышел: исход по сроку известен только у решённого.
  expect(view.overview.resolution).toMatchObject({ total: 1 });
  expect(view.lines.resolved).toBe(1);
  // В выгрузке у открытого заново времени решения нет.
  const csv = await exportMetrics(staffCtx(f.care), { ...WEEK, report: 'requests' });
  const minutes = (csv.columns as readonly string[]).indexOf('resolutionMinutes');
  expect(minutes).toBeGreaterThan(-1);
  expect(csv.rows.map((row) => row[minutes])).toEqual([120, null]);
});

test('источники: портал 120, почта 60, сотрудник 20; источников без обращений в списке нет', async () => {
  await seedMetrics();
  const view = await getMetrics(staffCtx(f.care), WEEK, NOW);
  expect(view.sources).toEqual([
    { source: 'portal', count: 120, percent: 60 },
    { source: 'email', count: 60, percent: 30 },
    { source: 'staff', count: 20, percent: 10 },
  ]);
});

test('линии: доля решённых на каждой, среднее время на линии и возвраты, передача правилом учтена', async () => {
  await seedMetrics();
  const { lines } = await getMetrics(staffCtx(f.l1), WEEK, NOW);
  expect(lines.resolved).toBe(140);
  expect(lines.returns).toBe(20);
  const row = (line: string) => lines.rows.find((r) => r.line === line);
  // Первая линия решила А (80). На ней были А по 120 минут, Б по 60 и В по 60: 13200 минут на 140 обращений.
  expect(row('first')).toMatchObject({ resolved: 80, percent: 57.1, visited: 140 });
  expect(row('first')?.averageMinutes).toBeCloseTo(13200 / 140, 6);
  // Вторая линия решила Б (40). На ней были Б по 660 минут и В по 60: 27600 минут на 60 обращений.
  expect(row('second')).toEqual({ line: 'second', resolved: 40, percent: 28.6, visited: 60, averageMinutes: 460 });
  // Разработка: В (20), по 240 минут.
  expect(row('development')).toEqual({ line: 'development', resolved: 20, percent: 14.3, visited: 20, averageMinutes: 240 });
});

test('срез по организациям и модулям сходится с ручным пересчётом, "Показать ещё" листает', async () => {
  const s = await seedMetrics();
  const care = staffCtx(f.care);
  const orgs = await getMetricsBreakdown(care, { ...WEEK, by: 'org' }, NOW);
  expect(orgs.hasMore).toBe(false);
  expect(orgs.items.map((item) => ({ ...item, csatAverage: item.csatAverage === null ? null : Math.round(item.csatAverage * 1000) / 1000 }))).toEqual([
    // А: 80 + 40 + 10 дублей. Первый ответ: 80 из 120. Решение: 110 из 120. 45 оценок, среднее 3,778.
    { key: f.orgA.orgId, name: 'ACME Trade', created: 130, resolved: 120, firstResponsePercent: 66.7, resolutionPercent: 91.7, csatCount: 45, csatAverage: 3.778 },
    // Б: 20 + 30 + 20. Первый ответ: 50 из 60. Решение: 30 из 40. Оценок нет.
    { key: f.orgB.orgId, name: 'Globex', created: 70, resolved: 20, firstResponsePercent: 83.3, resolutionPercent: 75, csatCount: 0, csatAverage: null },
  ]);
  const modules = await getMetricsBreakdown(care, { ...WEEK, by: 'module', locale: 'en' }, NOW);
  expect(modules.items).toEqual([
    // Модуль 1: А 80, Г 30, Е 10. Первый ответ 110 из 110, решение 90 из 100, оценки А: 100 на 25.
    { key: s.m1, name: 'Orders', created: 120, resolved: 80, firstResponsePercent: 100, resolutionPercent: 90, csatCount: 25, csatAverage: 4 },
    // Модуль 2: Б 40, Д 20. Первый ответ 0 из 50, решение 30 из 40, оценки Б: 70 на 20.
    { key: s.m2, name: 'Склад', created: 60, resolved: 40, firstResponsePercent: 0, resolutionPercent: 75, csatCount: 20, csatAverage: 3.5 },
    { key: null, name: null, created: 20, resolved: 20, firstResponsePercent: 100, resolutionPercent: 100, csatCount: 0, csatAverage: null },
  ]);
  // Страница среза 50 строк: 60 организаций по одному обращению дают "Показать ещё".
  await pools.root.query(
    `with o as (insert into hdu_organizations (server_id, external_company_id, name) select $1, 'many-' || g, 'Много ' || g from generate_series(1, 60) g returning org_id)
     insert into hdt_tickets (org_id, author_id, type, impact, priority, visibility, title, description, locale, source) select org_id, $2, 'question', 'minor', 'p3', 'org', 'Сегодня', 'Текст', 'ru', 'portal' from o`,
    [f.server.serverId, f.aUser.userId],
  );
  const first = await getMetricsBreakdown(care, { period: '7', by: 'org' });
  expect([first.items.length, first.hasMore, first.pages]).toEqual([50, true, 1]);
  const more = await getMetricsBreakdown(care, { period: '7', by: 'org', pages: 2 });
  expect([more.items.length, more.hasMore]).toEqual([62, false]);
  // Больше обращений выше: у организации А три обращения набора изоляции, у Б два.
  expect(more.items.slice(0, 2).map((item) => [item.name, item.created])).toEqual([['ACME Trade', 3], ['Globex', 2]]);
  await expect(getMetricsBreakdown(care, { period: '7', by: 'server' })).rejects.toMatchObject({ code: 'invalid_input' });
  await expect(getMetricsBreakdown(care, { period: '7', by: 'org', pages: 0 })).rejects.toMatchObject({ code: 'invalid_input' });
});

test('низкие оценки: 15 обращений периода с оценкой 1-3, с причиной, организацией и исполнителем; вне периода нет', async () => {
  const s = await seedMetrics();
  const { lowRatings } = await getMetrics(staffCtx(f.l1), WEEK, NOW);
  expect(lowRatings.capped).toBe(false);
  expect(lowRatings.items).toHaveLength(15);
  // Новые первыми: сначала Б (среда), потом А (вторник).
  expect(lowRatings.items.slice(0, 10).map((item) => item.score).sort()).toEqual([1, 1, 1, 1, 1, 3, 3, 3, 3, 3]);
  expect(lowRatings.items.slice(10).map((item) => item.score)).toEqual([2, 2, 2, 2, 2]);
  const one = lowRatings.items.find((item) => item.number === s.number(81));
  expect(one).toMatchObject({ orgName: 'ACME Trade', assigneeName: f.l1.name, score: 1, reason: 'not_solved', comment: 'Так и не решили 81', reviewNote: null, reviewedByName: null, reviewedOn: null });
  const numbers = lowRatings.items.map((item) => item.number);
  expect(numbers).not.toContain(s.number(201));
  expect(numbers).not.toContain(s.number(202));
});

test('период без обращений: нули и пустые списки, деления на ноль нет', async () => {
  await seedMetrics();
  const view = await getMetrics(staffCtx(f.l1), { period: 'custom', from: '2020-01-01', to: '2020-01-07' }, NOW);
  expect(view.overview).toEqual({
    created: 0,
    resolved: 0,
    closed: 0,
    finished: 0,
    firstResponse: { total: 0, ok: 0, percent: null },
    resolution: { total: 0, ok: 0, percent: null },
    firstResponseTime: { count: 0, averageMinutes: null, medianMinutes: null },
    resolutionTime: { count: 0, averageMinutes: null, medianMinutes: null },
    csat: { count: 0, average: null, highPercent: null },
  });
  expect(view.sources).toEqual([]);
  expect(view.lines).toMatchObject({ resolved: 0, returns: 0 });
  // Четыре линии с вехи M5b: AI-помощник, первая, вторая, разработка.
  expect(view.lines.rows.map((row) => [row.resolved, row.percent, row.averageMinutes])).toEqual([[0, null, null], [0, null, null], [0, null, null], [0, null, null]]);
  expect(view.lowRatings.items).toEqual([]);
  expect((await getMetricsBreakdown(staffCtx(f.care), { period: 'custom', from: '2020-01-01', to: '2020-01-07', by: 'org' }, NOW)).items).toEqual([]);
});

test('негодный период отклоняется: длиннее 366 дней, конец раньше начала, мусор', async () => {
  const l1 = staffCtx(f.l1);
  for (const input of [
    { period: 'custom', from: '2025-11-01', to: '2026-11-08' },
    { period: 'custom', from: '2026-11-08', to: '2026-11-02' },
    { period: '14' },
    { period: 'custom', from: 'вчера', to: 'сегодня' },
  ])
    await expect(getMetrics(l1, input, NOW), JSON.stringify(input)).rejects.toMatchObject({ code: 'invalid_input' });
  // Период не назван: 30 дней до сегодня.
  expect((await getMetrics(l1, {}, NOW)).period).toMatchObject({ preset: '30', toDay: '2026-11-20' });
});

test('права по решению 14: страницу видят все сотрудники; срез и выгрузку care, product, admin и руководители линий; заметку пишут care и admin', async () => {
  const s = await seedMetrics();
  const l2 = await staffWithRole('agent_l2');
  const product = await staffWithRole('product');
  const roles: Record<string, StaffContext> = {
    agent_l1: staffCtx(f.l1),
    agent_l2: staffCtx(l2),
    care: staffCtx(f.care),
    product: staffCtx(product),
    admin: staffCtx(f.adminStaff),
    lead_l1: lead(f.l1),
    lead_l2: lead(l2),
  };
  const allowed = { breakdown: ['care', 'product', 'admin', 'lead_l1', 'lead_l2'], review: ['care', 'admin'] };
  let target = 81;
  for (const [name, ctx] of Object.entries(roles)) {
    expect((await getMetrics(ctx, WEEK, NOW)).overview.created, name).toBe(200);
    const breakdown = getMetricsBreakdown(ctx, { ...WEEK, by: 'org' }, NOW);
    const exported = exportMetrics(ctx, { ...WEEK, report: 'orgs' }, NOW);
    if (allowed.breakdown.includes(name)) {
      expect((await breakdown).items, name).toHaveLength(2);
      expect((await exported).rows, name).toHaveLength(2);
    } else {
      await expect(breakdown, name).rejects.toMatchObject({ code: 'forbidden' });
      await expect(exported, name).rejects.toMatchObject({ code: 'forbidden' });
    }
    const review = saveCsatReview(ctx, { number: s.number(target), note: `Разбор от ${name}` });
    if (allowed.review.includes(name)) {
      await review;
      target += 1;
    } else await expect(review, name).rejects.toMatchObject({ code: 'forbidden' });
  }
  // Отказ в выгрузке не пишет журнал и не тратит попытки: записей столько, сколько удачных выгрузок.
  expect(await audit('metrics.exported')).toHaveLength(allowed.breakdown.length);
  expect(await audit('ticket.csat_reviewed')).toHaveLength(allowed.review.length);
});

test('клиент не получает ничего: ни страницы, ни среза, ни выгрузки, ни заметки', async () => {
  const s = await seedMetrics();
  const client = (await clientCtx(f.aAdmin)) as unknown as StaffContext;
  await expect(getMetrics(client, WEEK, NOW)).rejects.toMatchObject({ code: 'forbidden' });
  await expect(getMetricsBreakdown(client, { ...WEEK, by: 'org' }, NOW)).rejects.toMatchObject({ code: 'forbidden' });
  await expect(exportMetrics(client, { ...WEEK, report: 'requests' }, NOW)).rejects.toMatchObject({ code: 'forbidden' });
  await expect(saveCsatReview(client, { number: s.number(81), note: 'Клиент пишет заметку' })).rejects.toMatchObject({ code: 'forbidden' });
  expect(await audit('metrics.exported')).toEqual([]);
});

test('заметка о разборе: колонки, внутреннее событие и журнал одной транзакцией; только к оценке 1-3', async () => {
  const s = await seedMetrics();
  const care = staffCtx(f.care);
  await saveCsatReview(care, { number: s.number(81), note: '  Позвонили клиенту, проблема в настройке прав.  ' });
  const row = (await pools.root.query(`select csat_review_note, csat_reviewed_by, csat_reviewed_on from hdt_tickets where ticket_id = $1`, [s.id(81)])).rows[0];
  expect(row.csat_review_note).toBe('Позвонили клиенту, проблема в настройке прав.');
  expect(row.csat_reviewed_by).toBe(f.care.userId);
  expect(row.csat_reviewed_on).toBeInstanceOf(Date);
  const events = (await pools.root.query(`select kind, actor_id, is_internal, payload from hdt_ticket_events where ticket_id = $1 and kind = 'csat_review'`, [s.id(81)])).rows;
  expect(events).toEqual([{ kind: 'csat_review', actor_id: f.care.userId, is_internal: true, payload: { score: 1, note: 'Позвонили клиенту, проблема в настройке прав.' } }]);
  // В журнале нет текста заметки: только оценка и признак правки.
  expect(await audit('ticket.csat_reviewed')).toEqual([{ actor_id: f.care.userId, object_type: 'ticket', object_id: s.id(81), org_id: f.orgA.orgId, diff: { score: 1, updated: false } }]);
  // Заметка видна в списке низких оценок с именем автора; администратор может её переписать.
  const item = (await getMetrics(staffCtx(f.l1), WEEK, NOW)).lowRatings.items.find((x) => x.number === s.number(81));
  expect(item).toMatchObject({ reviewNote: 'Позвонили клиенту, проблема в настройке прав.', reviewedByName: f.care.name });
  await saveCsatReview(staffCtx(f.adminStaff), { number: s.number(81), note: 'Уточнение' });
  expect((await audit('ticket.csat_reviewed')).map((a) => a.diff)).toEqual([{ score: 1, updated: false }, { score: 1, updated: true }]);
  // История обращения сотрудника показывает разбор, клиент события не получает.
  const agentView = await getAgentTicket(care, s.number(81));
  expect(JSON.stringify(agentView?.timeline)).toContain('csat_review');

  // Оценка 5, обращение без оценки, несуществующее, пустая и слишком длинная заметка.
  await expect(saveCsatReview(care, { number: s.number(1), note: 'Разбор' })).rejects.toMatchObject({ code: 'invalid_input' });
  await expect(saveCsatReview(care, { number: s.number(141), note: 'Разбор' })).rejects.toMatchObject({ code: 'invalid_input' });
  await expect(saveCsatReview(care, { number: 999_999, note: 'Разбор' })).rejects.toMatchObject({ code: 'not_found' });
  await expect(saveCsatReview(care, { number: s.number(82), note: '   ' })).rejects.toMatchObject({ code: 'invalid_input' });
  await expect(saveCsatReview(care, { number: s.number(82), note: 'x'.repeat(2001) })).rejects.toMatchObject({ code: 'invalid_input' });
  await saveCsatReview(care, { number: s.number(82), note: 'x'.repeat(2000) });
});

test('клиент заметку о разборе не получает: запросы клиента колонки не выбирают, страница обращения её не несёт', async () => {
  const s = await seedMetrics();
  const secret = 'ВНУТРЕННИЙ-РАЗБОР-НЕ-ДЛЯ-КЛИЕНТА';
  await saveCsatReview(staffCtx(f.care), { number: s.number(81), note: secret });
  const ctx = await clientCtx(f.aUser);
  const { result, queries } = await captureQueries(async () => ({ ticket: await getTicket(ctx, s.number(81)), list: await listTickets(ctx, {}) }));
  expect(result.ticket?.csat).toEqual({ score: 1, reason: 'not_solved', comment: 'Так и не решили 81' });
  expect(JSON.stringify(result)).not.toContain(secret);
  expect(JSON.stringify(result)).not.toContain('csat_review');
  expect(queries.length).toBeGreaterThan(0);
  for (const query of queries) expect(query.text, query.text).not.toMatch(/csat_review/);
  // Клиент видит строку обращения, поэтому события разбора в его истории быть не должно.
  expect(result.ticket?.events.map((e) => e.kind)).not.toContain('csat_review');
});

test('база не даёт записать заметку в обход кода: клиенту, первой линии, к высокой оценке, от чужого имени', async () => {
  const s = await seedMetrics();
  const write = (actor: Parameters<typeof asActor>[1], g: number, by: string) =>
    asActor(pools.app, actor, (client) => client.query(`update hdt_tickets set csat_review_note = 'Обход', csat_reviewed_by = $2, csat_reviewed_on = now() where ticket_id = $1`, [s.id(g), by]));
  await expect(write(f.aAdmin.actor, 81, f.aAdmin.userId)).rejects.toMatchObject({ code: '42501' });
  await expect(write(f.l1.actor, 81, f.l1.userId)).rejects.toMatchObject({ code: '42501' });
  await expect(write(f.care.actor, 1, f.care.userId)).rejects.toMatchObject({ code: '42501' });
  await expect(write(f.care.actor, 81, f.l1.userId)).rejects.toMatchObject({ code: '42501' });
  await write(f.care.actor, 81, f.care.userId);
  // Новое обращение с готовой заметкой не создаётся.
  await expect(
    asActor(pools.app, f.care.actor, (client) =>
      client.query(
        `insert into hdt_tickets (org_id, author_id, type, impact, priority, visibility, title, description, locale, source, csat_review_note, csat_reviewed_by, csat_reviewed_on)
         values ($1, $2, 'question', 'minor', 'p3', 'org', 'Заметка сразу', 'Текст', 'ru', 'staff', 'Обход', $3, now())`,
        [f.orgA.orgId, f.aUser.userId, f.care.userId],
      ),
    ),
  ).rejects.toMatchObject({ code: '42501' });
});

test('выгрузка организаций: формула в названии организации получает апостроф, запись в журнале аудита', async () => {
  await seedMetrics();
  await pools.root.query(`update hdu_organizations set name = '=HYPERLINK("http://evil.example";"ACME")' where org_id = $1`, [f.orgA.orgId]);
  await pools.root.query(`update hdu_organizations set name = '+7 (71) 200-00-00; "Глобекс"' where org_id = $1`, [f.orgB.orgId]);
  const product = await staffWithRole('product');
  const out = await exportMetrics(staffCtx(product), { ...WEEK, report: 'orgs' }, NOW);
  expect(out).toMatchObject({ report: 'orgs', truncated: false, columns: ['org', 'created', 'resolved', 'firstResponsePercent', 'resolutionPercent', 'csatCount', 'csatAverage'] });
  expect(out.rows).toEqual([
    ['=HYPERLINK("http://evil.example";"ACME")', 130, 120, '66,7', '91,7', 45, '3,78'],
    ['+7 (71) 200-00-00; "Глобекс"', 70, 20, '83,3', '75', 0, ''],
  ]);
  const csv = buildCsv(out.columns, out.rows);
  expect(csv).toBe(
    '﻿org;created;resolved;firstResponsePercent;resolutionPercent;csatCount;csatAverage\r\n' +
      `"'=HYPERLINK(""http://evil.example"";""ACME"")";130;120;66,7;91,7;45;3,78\r\n` +
      `"'+7 (71) 200-00-00; ""Глобекс""";70;20;83,3;75;0;\r\n`,
  );
  // Ни одна ячейка файла не начинается со знака формулы.
  for (const line of csv.slice(1).trimEnd().split('\r\n')) for (const cell of line.split(';')) expect(cell.replace(/^"/, ''), cell).not.toMatch(/^[=+\-@\t\r]/);
  expect(await audit('metrics.exported')).toEqual([
    { actor_id: product.userId, object_type: 'metrics', object_id: null, org_id: null, diff: { report: 'orgs', from: '2026-11-02', to: '2026-11-08', rows: 2, truncated: false } },
  ]);
});

test('выгрузка обращений: строка на обращение, без темы и описания; модули и низкие оценки', async () => {
  const s = await seedMetrics();
  const care = staffCtx(f.care);
  await saveCsatReview(care, { number: s.number(81), note: '=cmd|разбор' });
  const requests = await exportMetrics(care, { ...WEEK, report: 'requests' }, NOW);
  expect(requests.rows).toHaveLength(200);
  expect(requests.columns).toEqual(['number', 'created', 'org', 'module', 'type', 'priority', 'source', 'status', 'firstResponseMinutes', 'resolutionMinutes', 'firstResponseBreached', 'resolutionBreached', 'score']);
  const row = (g: number) => requests.rows.find((r) => r[0] === `SUP-${s.number(g)}`);
  expect(row(1)).toEqual([`SUP-${s.number(1)}`, '2026-11-03 10:00', 'ACME Trade', 'orders', 'question', 'p3', 'portal', 'closed', 30, 120, 0, 0, 5]);
  expect(row(81)).toEqual([`SUP-${s.number(81)}`, '2026-11-04 09:00', 'ACME Trade', 'stock', 'question', 'p3', 'email', 'closed', 120, 600, 1, 1, 1]);
  expect(row(121)).toEqual([`SUP-${s.number(121)}`, '2026-11-05 09:00', 'Globex', '', 'question', 'p3', 'staff', 'resolved', 10, 360, 0, 0, null]);
  expect(row(171)).toEqual([`SUP-${s.number(171)}`, '2026-11-07 10:00', 'Globex', 'stock', 'question', 'p3', 'email', 'new', null, null, 1, 0, null]);
  // Дубль: времени решения нет, хотя дата решения у строки стоит.
  expect(row(191)?.slice(7, 10)).toEqual(['closed', null, null]);
  // По порядку создания; темы и описания в файле нет.
  expect(requests.rows[0]?.[1]).toBe('2026-11-03 10:00');
  expect(requests.rows.at(-1)?.[1]).toBe('2026-11-08 23:59');
  const text = JSON.stringify(requests.rows);
  expect(text).not.toContain('Тайное описание');
  expect(text).not.toMatch(/M-\d/);

  const modules = await exportMetrics(care, { ...WEEK, report: 'modules', locale: 'en' }, NOW);
  expect(modules.rows).toEqual([['Orders', 120, 80, '100', '90', 25, '4'], ['Склад', 60, 40, '0', '75', 20, '3,5'], ['', 20, 20, '100', '100', 0, '']]);

  const low = await exportMetrics(care, { ...WEEK, report: 'low_ratings' }, NOW);
  expect(low.rows).toHaveLength(15);
  const reviewed = low.rows.find((r) => r[0] === `SUP-${s.number(81)}`);
  expect(reviewed?.slice(0, 9)).toEqual([`SUP-${s.number(81)}`, '2026-11-04 09:00', 'ACME Trade', f.l1.name, 1, 'not_solved', 'Так и не решили 81', '=cmd|разбор', f.care.name]);
  expect(buildCsv(low.columns, low.rows)).toContain(";'=cmd|разбор;");

  await expect(exportMetrics(care, { ...WEEK, report: 'tickets' }, NOW)).rejects.toMatchObject({ code: 'invalid_input' });
  await expect(exportMetrics(care, { period: 'custom', from: '2025-01-01', to: '2026-11-08', report: 'orgs' }, NOW)).rejects.toMatchObject({ code: 'invalid_input' });
  // Отклонённые запросы журнал не пишут.
  expect((await audit('metrics.exported')).map((a) => a.diff.report)).toEqual(['requests', 'modules', 'low_ratings']);
});

test('выгрузка: не больше 20 в час на сотрудника, у другого сотрудника свой счёт', async () => {
  await seedMetrics();
  const care = staffCtx(f.care);
  const limit = RATE_RULES.metricsExportPerUser.limit;
  expect(limit).toBe(20);
  for (let i = 0; i < limit; i += 1) await exportMetrics(care, { ...WEEK, report: 'modules' }, NOW);
  await expect(exportMetrics(care, { ...WEEK, report: 'modules' }, NOW)).rejects.toMatchObject({ code: 'rate_limited' });
  expect(await audit('metrics.exported')).toHaveLength(limit);
  expect((await exportMetrics(staffCtx(f.adminStaff), { ...WEEK, report: 'modules' }, NOW)).rows).toHaveLength(3);
  // Через час счёт начинается заново.
  expect((await exportMetrics(care, { ...WEEK, report: 'modules' }, new Date(NOW.getTime() + 3601_000))).rows).toHaveLength(3);
});

describe('50 тысяч обращений', () => {
  const SEQ_SCAN = /Seq Scan on hdt_tickets/;

  test('запросы показателей идут по индексу даты создания, страница за 90 дней укладывается в 2 секунды, выгрузка обрезается на 50 тысячах строк', async () => {
    await seedBulkTickets(50_000, 200, f.l1.userId);
    // Нагрузочный набор создан за последние 35 суток. Обращения разносятся на два года: одно в 20 минут,
    // так период в 30 дней берёт около 4% таблицы, как в жизни.
    const client = await pools.root.connect();
    try {
      await client.query(`set session_replication_role = replica`);
      // Номера обращений между тестами не сбрасываются, поэтому счёт идёт по порядку строк.
      await client.query(
        `update hdt_tickets t set created_on = now() - (r.n * interval '20 minutes'), first_response_breached_on = case when r.n % 7 = 0 then now() end,
                csat_score = case when r.n % 9 = 0 then 1 + (r.n % 5) end,
                closed_on = case when t.status = 'closed' then now() - (r.n * interval '20 minutes') + interval '2 hours' end,
                resolved_on = case when t.status = 'resolved' then now() - (r.n * interval '20 minutes') + interval '2 hours' end
           from (select ticket_id, row_number() over (order by number) as n from hdt_tickets) r where r.ticket_id = t.ticket_id`,
      );
      await client.query(`set session_replication_role = origin`);
      await client.query(`analyze hdt_tickets`);
    } finally {
      await client.query(`set session_replication_role = origin`).catch(() => undefined);
      client.release();
    }
    const care = staffCtx(f.care);
    const index = (await pools.root.query(`select indexdef from pg_indexes where indexname = 'hdt_tickets_i25'`)).rows[0]?.indexdef as string;
    expect(index).toMatch(/\(created_on\)$/);

    for (const period of ['7', '30', '90']) {
      const { result, queries } = await captureQueries(async () => ({
        view: await getMetrics(care, { period }),
        orgs: await getMetricsBreakdown(care, { period, by: 'org' }),
        modules: await getMetricsBreakdown(care, { period, by: 'module' }),
        file: await exportMetrics(care, { period, report: 'requests' }),
      }));
      // 72 обращения в сутки; сегодняшний день в периоде неполный.
      expect(result.view.overview.created, period).toBeGreaterThan((Number(period) - 1) * 72 - 2);
      expect(result.view.overview.created, period).toBeLessThanOrEqual(Number(period) * 72 + 2);
      expect(result.file.rows.length, period).toBe(result.view.overview.created);
      const plans = await plansFor(f.care.actor, queries, 'hdt_tickets');
      expect(plans.length, period).toBeGreaterThanOrEqual(8);
      for (const plan of plans) {
        expect(plan, plan).not.toMatch(SEQ_SCAN);
        // Счётчик "завершено за период" идёт по своему индексу даты решения или закрытия (миграция 0066).
        expect(plan, plan).toMatch(/hdt_tickets_i2[56]/);
      }
      expect(plans.some((plan) => /hdt_tickets_i26/.test(plan)), period).toBe(true);
      // Закрытые и решённые обращения набора завершены через два часа после создания. Число сверяется с прямым счётом
      // под суперпользователем: статусы в наборе идут группами, поэтому доля завершённых в периоде не постоянна.
      const direct = await pools.root.query(
        `select count(*)::int as n from hdt_tickets where coalesce(resolved_on, closed_on) >= $1 and coalesce(resolved_on, closed_on) < $2 and status in ('resolved', 'closed') and merged_into_id is null`,
        [result.view.period.from, result.view.period.to],
      );
      expect(result.view.overview.finished, period).toBe(direct.rows[0].n);
      if (period === '90') expect(result.view.overview.finished).toBeGreaterThan(1000);
    }

    // Время страницы за 90 дней (около 6500 обращений периода): лучший из трёх прогонов.
    const times: number[] = [];
    for (let i = 0; i < 3; i += 1) {
      const started = performance.now();
      await getMetrics(care, { period: '90' });
      times.push(performance.now() - started);
    }
    process.stdout.write(`показатели: страница за 90 дней на 50 тысячах обращений, мс: ${times.map((ms) => Math.round(ms)).join(', ')}\n`);
    expectWithin(Math.min(...times), 2000, 'показатели за 90 дней на 50 тысячах обращений');

    // Год это больше половины набора: больше 50 тысяч строк выгрузка не отдаёт и говорит об этом.
    await pools.root.query(`insert into hdt_tickets (org_id, author_id, type, impact, priority, visibility, title, description, locale, source) select $1, $2, 'question', 'minor', 'p3', 'org', 'Сверх предела ' || g, 'Текст', 'ru', 'portal' from generate_series(1, 25000) g`, [f.orgA.orgId, f.aUser.userId]);
    const day = (instant: Date) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tashkent' }).format(instant);
    const today = new Date();
    const big = await exportMetrics(staffCtx(f.adminStaff), { period: 'custom', from: day(new Date(today.getTime() - 365 * 86_400_000)), to: day(today), report: 'requests' });
    expect(big.truncated).toBe(true);
    expect(big.rows).toHaveLength(50_000);
    expect(buildCsv(big.columns, big.rows, { notice: 'Показаны первые 50000 строк' }).split('\r\n')[0]).toBe('﻿Показаны первые 50000 строк');
  }, 240_000);
});
