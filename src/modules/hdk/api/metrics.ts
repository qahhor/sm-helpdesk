import 'server-only';
import * as z from 'zod';
import { withActor } from '@/db/with-actor';
import type { StaffContext } from '@/modules/hdc/api';
import { canSeeBreakdown } from '@/modules/hdt/api/metrics';
import { orgFactsTx } from '@/modules/hdu/api/automation';
import { type DeflectionCounters, deflectionByOrgTx, deflectionTotalsTx } from '../core/metrics';
import { type SignatureRow, unsolvedSignaturesTx } from '../core/signatures';
import { HdkError } from '../error';
import { KB_WRITER_ROLES } from '../pref';

// Модуль hdk, слой api: показатели знаний для страницы "Показатели" (FR-MET-02, 05; план M5, задача 11, решения 8,
// 12). Страница /agent/metrics собирает показатели поддержки (модуль hdt) и эти. Права как у страницы M8 (решение
// 14): сводку и частые ошибки видят все сотрудники, срез по организациям только те, кому hdt показывает срезы
// (Customer Care, продукт, администратор, руководители линий). Кеша нет: каждый показ считает заново.
//
// Доля самостоятельно решённых: сессии с "Помогло" среди всех сессий с показом подсказки. Ушедшие без действия (left)
// в неё не входят: неизвестно, решили ли они проблему; их число показывается отдельно.

/** Сколько частых сигнатур без решения на странице (FR-MET-05). */
export const UNSOLVED_LIMIT = 20;
/** Сколько организаций в срезе исходов подсказки. */
export const DEFLECTION_ORGS_LIMIT = 50;
/** Период не длиннее, чем у страницы показателей (366 дней), с запасом на сдвиг часового пояса. */
const MAX_RANGE_MS = 367 * 24 * 60 * 60 * 1000;

export type DeflectionShare = DeflectionCounters & { selfServicePercent: number | null; ticketPercent: number | null };
export type KnowledgeMetrics = {
  deflection: DeflectionShare;
  /** Срез по организациям; null, если сотруднику срезы не положены. */
  byOrg: (DeflectionShare & { orgId: string; name: string | null })[] | null;
  unsolved: SignatureRow[];
  /** "Создать решение" только у ролей черновиков (решение 10). */
  canCreate: boolean;
};

const input = z
  .strictObject({ from: z.date(), to: z.date() })
  .refine((range) => range.to.getTime() > range.from.getTime() && range.to.getTime() - range.from.getTime() <= MAX_RANGE_MS);

const percent = (part: number, total: number): number | null => (total > 0 ? Math.round((part / total) * 1000) / 10 : null);
const share = (c: DeflectionCounters): DeflectionShare => ({ ...c, selfServicePercent: percent(c.helped, c.shown), ticketPercent: percent(c.ticketCreated, c.shown) });

/** Показатели подсказки и частые ошибки без решения за период страницы показателей. */
export async function getKnowledgeMetrics(ctx: StaffContext, value: unknown): Promise<KnowledgeMetrics> {
  if ((ctx?.actor as { type?: string } | undefined)?.type !== 'staff') throw new HdkError('forbidden');
  const parsed = input.safeParse(value);
  if (!parsed.success) throw new HdkError('invalid_input');
  const range = parsed.data;
  const breakdown = canSeeBreakdown(ctx);
  return withActor(ctx.actor, async (tx) => {
    const totals = await deflectionTotalsTx(tx, range);
    const orgRows = breakdown ? await deflectionByOrgTx(tx, range, DEFLECTION_ORGS_LIMIT) : null;
    const names = orgRows ? await orgFactsTx(tx, orgRows.map((row) => row.orgId)) : new Map<string, { name: string }>();
    return {
      deflection: share(totals),
      byOrg: orgRows ? orgRows.map((row) => ({ ...share(row), orgId: row.orgId, name: names.get(row.orgId)?.name ?? null })) : null,
      unsolved: await unsolvedSignaturesTx(tx, { ...range, limit: UNSOLVED_LIMIT }),
      canCreate: (KB_WRITER_ROLES as readonly string[]).includes(ctx.actor.staffRole),
    };
  });
}
