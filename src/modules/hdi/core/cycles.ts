import 'server-only';
import { and, asc, desc, eq, gt, inArray, lt, sql } from 'drizzle-orm';
import type { Tx } from '@/db/client';
import type { Locale } from '@/i18n/locales';
import { writeAudit } from '@/modules/hdc/api';
import { notifyManyTx } from '@/modules/hdn/api/idea-notices';
import { HdiError } from '../error';
import { CYCLE_ARCHIVE_LIMIT, type CycleStatus, ideaRef, SHORTLIST_SIZE, type VoteMode } from '../pref';
import { ideaCycles, ideas, ideaTranslations, type ShortlistEntry } from '../schema';
import { notifyIdeaStatusTx } from './notices';

// Модуль hdi, слой core: отбор месяца (ТЗ FR-IDEA-09, 10, 16; план M7, задача 9, решения 3, 16, 17).
//
// Снимок делает задание ideas.cycle от имени системы одной транзакцией под блокировкой: прошлый невыбранный отбор
// закрывается как lapsed (триггер t_hdi_cycles_return_shortlist возвращает его пятёрку в голосование), кандидаты
// это идеи open хотя бы с одним голосом, порядок по счётчику выбранного способа, при равенстве раньше созданная,
// затем меньший номер. Первые пять получают shortlisted, снимок хранит номер, оба счётчика и место. Уникальность
// месяца (hdi_cycles_u1) и блокировка транзакции делают повторный и параллельный запуск безвредными.
//
// Выбор делает product или admin в своей транзакции: строка отбора блокируется, второй выбор получает cycle_closed.
// Не лидер выбирается только с объяснением на русском (проверка hdi_cycles_c7 держит то же в базе).

export type CycleRun = { status: 'exists'; cycle: string } | { status: 'created'; cycle: string; shortlist: number[]; lapsed: number; cycleId: string; ideas: { ideaId: string; number: number; authorId: string }[] };

/** Снимок пятёрки за месяц cycle (первое число). Вызывает задание от имени системы. */
export async function runCycleTx(tx: Tx, cycle: string, mode: VoteMode): Promise<CycleRun> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext('hdi.cycle'))`);
  const [existing] = await tx.select({ cycleId: ideaCycles.cycleId }).from(ideaCycles).where(eq(ideaCycles.cycle, cycle)).limit(1);
  if (existing) return { status: 'exists', cycle };

  // Прошлые отборы без выбора закрываются (решение 17): триггер возвращает их пятёрку в голосование.
  const lapsed = await tx
    .update(ideaCycles)
    .set({ status: 'lapsed' })
    .where(and(eq(ideaCycles.status, 'open'), lt(ideaCycles.cycle, cycle)))
    .returning({ cycleId: ideaCycles.cycleId, cycle: ideaCycles.cycle });
  for (const row of lapsed) await writeAudit(tx, { action: 'idea.cycle_lapsed', objectType: 'idea_cycle', objectId: row.cycleId, diff: { cycle: row.cycle } });

  const score = mode === 'per_org' ? ideas.orgCount : ideas.voteCount;
  const candidates = await tx
    .select({ ideaId: ideas.ideaId, number: ideas.number, authorId: ideas.authorId, voteCount: ideas.voteCount, orgCount: ideas.orgCount })
    .from(ideas)
    .where(and(eq(ideas.status, 'open'), gt(score, 0)))
    .orderBy(desc(score), asc(ideas.createdOn), asc(ideas.number))
    .limit(SHORTLIST_SIZE)
    .for('update');
  const shortlist: ShortlistEntry[] = candidates.map((c, i) => ({ ideaId: c.ideaId, number: c.number, voteCount: c.voteCount, orgCount: c.orgCount, place: i + 1 }));
  if (candidates.length > 0)
    await tx
      .update(ideas)
      .set({ status: 'shortlisted' })
      .where(
        and(
          inArray(
            ideas.ideaId,
            candidates.map((c) => c.ideaId),
          ),
          eq(ideas.status, 'open'),
        ),
      );
  // Пустой отбор записывается и сразу закрывается: выбирать не из чего (решение 16).
  const [row] = await tx
    .insert(ideaCycles)
    .values({ cycle, shortlist, voteMode: mode, leaderIdeaId: candidates[0]?.ideaId ?? null, status: candidates.length > 0 ? 'open' : 'lapsed' })
    .returning({ cycleId: ideaCycles.cycleId });
  if (!row) throw new Error('hdi: отбор не сохранён');
  await writeAudit(tx, { action: 'idea.cycle_created', objectType: 'idea_cycle', objectId: row.cycleId, diff: { cycle, mode, shortlist: candidates.map((c) => ideaRef(c.number)) } });
  return { status: 'created', cycle, cycleId: row.cycleId, shortlist: candidates.map((c) => c.number), lapsed: lapsed.length, ideas: candidates };
}

/** Уведомления снимка: проголосовавшим, авторам и подписчикам идей пятёрки "В шорт-листе" (решение 15), роли product сводка. */
export async function notifyCycleTx(tx: Tx, run: Extract<CycleRun, { status: 'created' }>, productIds: readonly string[]): Promise<void> {
  for (const idea of run.ideas) await notifyIdeaStatusTx(tx, { ...idea, status: 'shortlisted' });
  if (run.ideas.length === 0) return;
  await notifyManyTx(tx, {
    kind: 'idea_cycle',
    ideaId: null,
    userIds: productIds,
    payload: { count: run.ideas.length },
    mail: { payload: { template: 'staff_idea_cycle', count: run.ideas.length, url: '/agent/ideas/cycles' }, settingsPath: '/agent/account', always: true, dayKey: '' },
  });
}

export type CycleRow = typeof ideaCycles.$inferSelect;

export type Decision = { number: number; explanationRu: string | null; explanationUz: string | null; explanationEn: string | null };

/**
 * Выбор идеи месяца (решение 17). Отказы: not_found (нет отбора), cycle_closed (уже выбран или закрыт),
 * not_in_shortlist, explanation_required (не лидер без объяснения на русском), bad_transition (идею успели отклонить).
 */
export async function decideTx(tx: Tx, cycle: string, decision: Decision): Promise<{ cycle: CycleRow; idea: { ideaId: string; number: number; authorId: string; orgId: string } }> {
  const [row] = await tx.select().from(ideaCycles).where(eq(ideaCycles.cycle, cycle)).limit(1).for('update');
  if (!row) throw new HdiError('not_found');
  if (row.status !== 'open') throw new HdiError('cycle_closed');
  const entry = row.shortlist.find((s) => s.number === decision.number);
  if (!entry) throw new HdiError('not_in_shortlist');
  const leader = entry.ideaId === row.leaderIdeaId;
  if (!leader && !decision.explanationRu) throw new HdiError('explanation_required');
  const [idea] = await tx
    .select({ ideaId: ideas.ideaId, number: ideas.number, authorId: ideas.authorId, orgId: ideas.orgId, status: ideas.status })
    .from(ideas)
    .where(eq(ideas.ideaId, entry.ideaId))
    .limit(1)
    .for('update');
  if (!idea || idea.status !== 'shortlisted') throw new HdiError('bad_transition');
  // Сначала отбор: триггер возвращает остальных из пятёрки в голосование от имени системы.
  const [decided] = await tx
    .update(ideaCycles)
    .set({ status: 'decided', selectedIdeaId: idea.ideaId, explanationRu: decision.explanationRu, explanationUz: decision.explanationUz, explanationEn: decision.explanationEn })
    .where(and(eq(ideaCycles.cycleId, row.cycleId), eq(ideaCycles.status, 'open')))
    .returning();
  if (!decided) throw new HdiError('cycle_closed');
  await tx.update(ideas).set({ status: 'selected', selectedCycle: cycle }).where(and(eq(ideas.ideaId, idea.ideaId), eq(ideas.status, 'shortlisted')));
  await writeAudit(tx, {
    action: 'idea.cycle_decided',
    objectType: 'idea_cycle',
    objectId: row.cycleId,
    diff: { cycle, idea: ideaRef(idea.number), leader, explained: { ru: decision.explanationRu !== null, uz: decision.explanationUz !== null, en: decision.explanationEn !== null } },
  });
  await writeAudit(tx, { action: 'idea.status_changed', objectType: 'idea', objectId: idea.ideaId, orgId: idea.orgId, diff: { number: ideaRef(idea.number), from: 'shortlisted', to: 'selected', cycle } });
  await notifyIdeaStatusTx(tx, { ...idea, status: 'selected' });
  return { cycle: decided, idea };
}

/** Заголовки идей на языке пользователя (перевод, видимый клиентам) или оригинал. */
export async function titlesForTx(tx: Tx, ideaIds: readonly string[], locale: Locale): Promise<Map<string, string>> {
  if (ideaIds.length === 0) return new Map();
  const rows = await tx
    .select({ ideaId: ideaTranslations.ideaId, locale: ideaTranslations.locale, title: ideaTranslations.title, status: ideaTranslations.status })
    .from(ideaTranslations)
    .where(and(inArray(ideaTranslations.ideaId, [...ideaIds]), inArray(ideaTranslations.status, ['original', 'machine', 'reviewed'])));
  const out = new Map<string, string>();
  for (const row of rows) if (row.status === 'original' && !out.has(row.ideaId)) out.set(row.ideaId, row.title);
  for (const row of rows) if (row.locale === locale) out.set(row.ideaId, row.title);
  return out;
}

/** Отборы от новых к старым: для сотрудника все, клиенту политика отдаёт только завершённые (decided, lapsed). */
export async function cyclesTx(tx: Tx, statuses: readonly CycleStatus[]): Promise<CycleRow[]> {
  return tx
    .select()
    .from(ideaCycles)
    .where(inArray(ideaCycles.status, [...statuses]))
    .orderBy(desc(ideaCycles.cycle))
    .limit(CYCLE_ARCHIVE_LIMIT);
}

/** Живые счётчики и статусы идей снимка (сотруднику: голоса после снимка лидера не меняют). */
export async function liveCountsTx(tx: Tx, ideaIds: readonly string[]): Promise<Map<string, { voteCount: number; orgCount: number; status: string }>> {
  if (ideaIds.length === 0) return new Map();
  const rows = await tx.select({ ideaId: ideas.ideaId, voteCount: ideas.voteCount, orgCount: ideas.orgCount, status: ideas.status }).from(ideas).where(inArray(ideas.ideaId, [...ideaIds]));
  return new Map(rows.map((r) => [r.ideaId, { voteCount: r.voteCount, orgCount: r.orgCount, status: r.status }]));
}

/** Номера идей по идентификаторам (выбранная идея в архиве). */
export async function numbersOfTx(tx: Tx, ideaIds: readonly string[]): Promise<Map<string, number>> {
  if (ideaIds.length === 0) return new Map();
  const rows = await tx.select({ ideaId: ideas.ideaId, number: ideas.number }).from(ideas).where(inArray(ideas.ideaId, [...ideaIds]));
  return new Map(rows.map((r) => [r.ideaId, r.number]));
}
