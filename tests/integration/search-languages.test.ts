import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { containsText } from '@/db/contains';
import { withActor } from '@/db/with-actor';
import { runSearchSync, setSearchForTests, setSearchKeysForTests } from '@/modules/hdc/api';
import { MemoryJobQueue, setJobQueueForTests } from '@/modules/hdc/testing';
import { saveSearchSetting } from '@/modules/hdk/api/search-settings';
import { staffTextSearch } from '@/modules/hdt/core/text-search';
import { tickets } from '@/modules/hdt/schema';
import { or } from 'drizzle-orm';
import { registerSearch } from '@/worker/search';
import { staffCtx } from './helpers/auth';
import { pools, system } from './helpers/db';
import { type LiveSearch, liveSearch, typesenseSkip } from './helpers/search';
import { type Fixture, seedTwoOrgs } from './isolation/fixture';

// Языки поиска на Typesense 30.2 (план W6, задача 9, решения 7-9): русский с опечаткой, формами слова и латиницей;
// узбекский на двух письменностях, с апострофами и без, x/h, q/k; английский с опечаткой, формой и началом слова;
// синонимы между языками; вежливые слова в длинном описании не мешают. Узбекские примеры исполнителя, черновик: их
// должен проверить носитель языка. Для каждого запроса считается, нашёл бы его прежний путь PostgreSQL.

registerSearch();

const DOCS: Record<string, { title: string; locale: string }> = {
  ru1: { title: 'Оплата не проходит в кассе', locale: 'ru' },
  ru2: { title: 'Накладная не печатается', locale: 'ru' },
  uz1: { title: "To'lov o'tmayapti kassada", locale: 'uz' },
  uz2: { title: 'Hisobot ochilmayapti', locale: 'uz' },
  uz3: { title: 'Qarz summasi noto‘g‘ri', locale: 'uz' },
  uz4: { title: 'Ombor qoldigi mos emas', locale: 'uz' },
  en1: { title: 'Invoice is not printed', locale: 'en' },
  en2: { title: 'Sales report is empty', locale: 'en' },
  en3: { title: 'Warehouse balance is wrong', locale: 'en' },
};

const CASES: [string, string][] = [
  ['оплата не праходит', 'ru1'],
  ['накладные не печатаются', 'ru2'],
  ['nakladnaya', 'ru2'],
  ['tolov otmayapti', 'uz1'],
  ['тўлов ўтмаяпти', 'uz1'],
  ['xisobot', 'uz2'],
  ['karz summasi', 'uz3'],
  ['invioce', 'en1'],
  ['reports', 'en2'],
  ['warehou', 'en3'],
  ['склад', 'uz4'],
  ['пожалуйста помогите накладная не печатается срочно', 'ru2'],
];

describe.skipIf(typesenseSkip !== null)(`языки поиска на Typesense 30.2${typesenseSkip ? ` (пропущено: ${typesenseSkip})` : ''}`, () => {
  let f: Fixture;
  let live: LiveSearch;
  const ids: Record<string, string> = {};

  // Таблицы очищаются перед каждым тестом (setup/each.ts): набор строк и индекс строятся заново.
  beforeEach(async () => {
    f = await seedTwoOrgs();
    setJobQueueForTests(new MemoryJobQueue());
    for (const [key, doc] of Object.entries(DOCS))
      ids[key] = (
        await pools.root.query(
          `insert into hdt_tickets (org_id, author_id, type, impact, priority, title, description, locale, source) values ($1, $2, 'bug', 'minor', 'p3', $3, 'описание', $4, 'portal') returning ticket_id`,
          [f.orgA.orgId, f.aUser.userId, doc.title, doc.locale],
        )
      ).rows[0].ticket_id as string;
    live = await liveSearch();
    setSearchForTests(live.reader, live.writer);
    setSearchKeysForTests({ client: live.keys.clientSearch, staff: live.keys.staffSearch });
    expect(await saveSearchSetting(staffCtx(f.adminStaff), { kind: 'synonyms', text: 'склад, ombor, warehouse' })).toEqual({ ok: true });
    await runSearchSync(system, live.writer);
  });
  afterEach(() => {
    setSearchForTests(null);
    setSearchKeysForTests(null);
    setJobQueueForTests(null);
  });

  test.each(CASES)('"%s" находит %s', async (q, key) => {
    const found = await staffTextSearch(f.l1.actor, q);
    expect(found, 'Typesense ответил').not.toBeNull();
    expect(found!.ids).toContain(ids[key]);
  });

  test('доля найденного против прежнего пути PostgreSQL', async () => {
    let typesense = 0;
    let postgres = 0;
    for (const [q, key] of CASES) {
      if ((await staffTextSearch(f.l1.actor, q))?.ids.includes(ids[key]!)) typesense++;
      const rows = await withActor(f.l1.actor, (tx) => tx.select({ id: tickets.ticketId }).from(tickets).where(or(containsText(tickets.title, q), containsText(tickets.description, q))));
      if (rows.some((r) => r.id === ids[key])) postgres++;
    }
    console.info(`языки поиска: Typesense нашёл ${typesense} из ${CASES.length}, прежний путь PostgreSQL ${postgres} из ${CASES.length}`);
    expect(typesense).toBe(CASES.length);
    expect(postgres).toBeLessThan(typesense);
  });
});
