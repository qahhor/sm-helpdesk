import { expect, test } from 'vitest';
import { seedBulkTickets } from './helpers/bulk';
import { pools } from './helpers/db';
import { seedTwoOrgs } from './isolation/fixture';

// Индексы таблицы обращений (аудит 23.11.2026, находка P8; план W2, задача 3). Смена статуса меняет колонку
// из индексов, поэтому новая версия строки записывается в каждый индекс, куда строка входит. Полный индекс
// по колонке, которая почти всегда пуста, стоит записи на каждое обновление и ничего не даёт.

const indexes = async () =>
  Object.fromEntries((await pools.root.query(`select indexname, indexdef from pg_indexes where tablename = 'hdt_tickets'`)).rows.map((r) => [r.indexname, r.indexdef as string])) as Record<string, string>;

test('лишний индекс по сроку решения убран, индексы по редким колонкам частичные', async () => {
  const all = await indexes();
  // Срок решения нужен только у открытых обращений: для них есть hdt_tickets_i13.
  expect(all.hdt_tickets_i8).toBeUndefined();
  expect(all.hdt_tickets_i13).toContain('resolution_due_on');
  // Прежние полные индексы по подписи ошибки, основному обращению дубля и связанному обращению заменены частичными.
  for (const name of ['hdt_tickets_i9', 'hdt_tickets_i10', 'hdt_tickets_i11']) expect(all[name], name).toBeUndefined();
  expect(all.hdt_tickets_i18).toMatch(/\(error_signature\) WHERE \(error_signature IS NOT NULL\)/);
  expect(all.hdt_tickets_i19).toMatch(/\(merged_into_id\) WHERE \(merged_into_id IS NOT NULL\)/);
  expect(all.hdt_tickets_i20).toMatch(/\(related_ticket_id\) WHERE \(related_ticket_id IS NOT NULL\)/);
  // Плюс два индекса поиска по тексту темы и описания (миграция 0052, решение владельца о поиске от 24.11.2026).
  // Плюс два частичных индекса момента "срок скоро" (миграция 0057, веха M8): в них только обращения, которые ждут события.
  expect(all.hdt_tickets_i23).toMatch(/\(first_response_soon_on\) WHERE \(first_response_soon_on IS NOT NULL\)/);
  expect(all.hdt_tickets_i24).toMatch(/\(resolution_soon_on\) WHERE \(resolution_soon_on IS NOT NULL\)/);
  // Плюс индекс по дате создания для страницы показателей (миграция 0065, веха M8, решение 15): дата создания не
  // меняется, поэтому обновлению без записи в индексы (HOT) он не мешает.
  expect(all.hdt_tickets_i25).toMatch(/\(created_on\)$/);
  // Плюс частичный индекс по дате решения или закрытия для счётчика "завершено за период" (миграция 0066, веха M8):
  // в нём только решённые и закрытые обращения, открытое обращение в него не входит.
  expect(all.hdt_tickets_i26).toMatch(/resolved_on IS NOT NULL[^]* WHERE [^]*IS NOT NULL\)$/);
  expect(all.hdt_tickets_i26).toContain('closed_on');
  // Плюс частичный индекс решённых кнопкой "Помогло" и открытых снова (миграция 0097, независимая проверка M5b, I3):
  // в нём только такие обращения, обычно ни одного.
  expect(all.hdt_tickets_i27).toMatch(/\(ticket_id\) WHERE \(\(ai_state = 'resolved_by_ai'::text\) AND/);
  expect(Object.keys(all)).toHaveLength(26);
});

test('обычное обращение без подписи ошибки и связей входит не больше чем в 16 индексов из 25: 13 прежних, два индекса поиска по тексту и индекс даты создания для показателей (было 17 из 20)', async () => {
  const f = await seedTwoOrgs();
  // Сколько индексов получают запись при обновлении этой строки: полные и те частичные, условию которых строка отвечает.
  // Всего индексов у таблицы 25 (их число сверяет тест выше). Новое открытое обращение набора входит ровно в 16:
  // остальные девять частичные, и их условию оно не отвечает. Обращение с подписью ошибки, отложенное, решённое
  // или закрытое входит в большее число индексов: тест меряет обычный случай, а не предел.
  const partial = (await pools.root.query(`select c.relname as name, pg_get_expr(i.indpred, i.indrelid) as pred from pg_index i join pg_class c on c.oid = i.indexrelid where i.indrelid = 'hdt_tickets'::regclass`)).rows;
  let included = 0;
  for (const index of partial) {
    if (!index.pred) included += 1;
    else if ((await pools.root.query(`select 1 from hdt_tickets where ticket_id = $1 and (${index.pred})`, [f.tickets.aOrg.ticketId])).rowCount) included += 1;
  }
  expect(included).toBeLessThanOrEqual(16);
});

test('поиск дублей основного обращения и связанных идёт по частичным индексам', async () => {
  const f = await seedTwoOrgs();
  await seedBulkTickets(20_000, 50, f.l1.userId);
  await pools.root.query(`update hdt_tickets set merged_into_id = $1 where number in (select number from hdt_tickets where ticket_id <> $1 order by number limit 5)`, [f.tickets.aOrg.ticketId]);
  await pools.root.query(`analyze hdt_tickets`);
  for (const column of ['merged_into_id', 'related_ticket_id', 'error_signature']) {
    const plan = (await pools.root.query(`explain (costs off) select ticket_id from hdt_tickets where ${column} = $1`, [column === 'error_signature' ? 'sig' : f.tickets.aOrg.ticketId])).rows
      .map((r) => Object.values(r)[0])
      .join('\n');
    expect(plan, plan).toMatch(/Index.*hdt_tickets_i(18|19|20)/);
    expect(plan, plan).not.toMatch(/Seq Scan/);
  }
}, 120_000);
