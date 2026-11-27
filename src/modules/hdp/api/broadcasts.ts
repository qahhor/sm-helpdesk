import 'server-only';
import { and, desc, eq } from 'drizzle-orm';
import * as z from 'zod';
import type { Tx } from '@/db/client';
import { withActor } from '@/db/with-actor';
import { isLocale, type Locale, LOCALES } from '@/i18n/locales';
import { enqueue, type StaffContext, writeAudit } from '@/modules/hdc/api';
import { problemTicketsTx } from '@/modules/hdt/api/known-problems';
import { requireProblemTx, updateProblemTx } from '../core/problems';
import { HdpError } from '../error';
import { parseInput } from '../input';
import { BROADCAST_BODY_MAX, BROADCAST_KINDS, BROADCAST_TICKET_STATUSES, type BroadcastKind, type BroadcastStatus, PROBLEM_NUMBER_MAX, PROBLEM_WRITER_ROLES } from '../pref';
import { broadcasts } from '../schema';
import { assertPublicText } from './problems';

// Модуль hdp, слой api: рассылка обновления и закрытие проблемы (ТЗ FR-KP-06, 07, 11.14, T23; план M5c, задача 5,
// решения 17-20). Готовят, подтверждают и закрывают agent_l2, care, admin.
//
// Порядок 11.14: сотрудник пишет текст на своём языке (проверка текста, решение 6), портал считает получателей и их
// языки и ставит машинные переводы задачей problems.translate; сотрудник видит "Получат: N обращений, M организаций",
// принимает или правит перевод на каждый язык и подтверждает. Без текста на языке получателей отправка недоступна,
// флажок "текстом оригинала" отправляет им оригинал. Подтверждение записывает получателей (привязанные открытые
// обращения на этот момент), ставит статус queued и задачу problems.broadcast. Закрытие той же транзакцией ставит
// проблеме "Закрыто": сигнатуры перестают притягивать обращения сразу (решение 20).

function requireWriter(ctx: StaffContext): void {
  if (ctx.actor.type !== 'staff' || !(PROBLEM_WRITER_ROLES as readonly string[]).includes(ctx.actor.staffRole)) throw new HdpError('forbidden');
}

const prepareInput = z.strictObject({
  number: z.number().int().positive().max(PROBLEM_NUMBER_MAX),
  kind: z.enum(BROADCAST_KINDS),
  body: z.string().trim().min(1).max(BROADCAST_BODY_MAX),
  locale: z.enum(LOCALES),
});
const confirmInput = z.strictObject({
  broadcastId: z.uuid(),
  translations: z.partialRecord(z.enum(LOCALES), z.string().trim().max(BROADCAST_BODY_MAX)),
  fallbackToOriginal: z.boolean(),
});

type Recipient = { ticketId: string; orgId: string; locale: Locale };

/** Получатели сейчас (решение 17): привязанные обращения в открытых статусах, не объединённые. */
async function recipientsTx(tx: Tx, problemId: string): Promise<Recipient[]> {
  const open: readonly string[] = BROADCAST_TICKET_STATUSES;
  return (await problemTicketsTx(tx, problemId))
    .filter((t) => open.includes(t.status) && t.mergedIntoId === null)
    .map((t) => ({ ticketId: t.ticketId, orgId: t.orgId, locale: isLocale(t.locale) ? t.locale : 'ru' }));
}

const summary = (list: readonly Recipient[]) => ({
  recipients: list.length,
  orgs: new Set(list.map((r) => r.orgId)).size,
  locales: [...new Set(list.map((r) => r.locale))].sort() as Locale[],
});

/**
 * Черновик рассылки (окно "Написать обновление всем" или "Закрыть проблему"): текст проверен, получатели посчитаны,
 * машинные переводы поставлены. Ничего не отправлено. Закрытие требует итогового текста (решение 20).
 */
export async function prepareBroadcast(ctx: StaffContext, input: unknown): Promise<{ broadcastId: string; recipients: number; orgs: number; locales: Locale[] }> {
  requireWriter(ctx);
  const data = parseInput(prepareInput, input);
  const prepared = await withActor(ctx.actor, async (tx) => {
    const problem = await requireProblemTx(tx, { number: data.number }, { lock: true });
    if (problem.status === 'closed') throw new HdpError('problem_closed');
    await assertPublicText(ctx.actor, tx, problem.problemId, [data.body]);
    const list = await recipientsTx(tx, problem.problemId);
    const [row] = await tx
      .insert(broadcasts)
      .values({ problemId: problem.problemId, authorId: ctx.actor.userId, kind: data.kind, sourceLocale: data.locale, body: { [data.locale]: data.body } })
      .returning({ broadcastId: broadcasts.broadcastId });
    return { broadcastId: row!.broadcastId, ...summary(list) };
  });
  for (const locale of prepared.locales.filter((l) => l !== data.locale)) await enqueue('problems.translate', { broadcastId: prepared.broadcastId, locale });
  return prepared;
}

export type BroadcastDraft = {
  broadcastId: string;
  kind: BroadcastKind;
  status: BroadcastStatus;
  sourceLocale: Locale;
  body: string;
  /** Машинные переводы для окна подтверждения: клиенту не уходят, пока сотрудник их не отправил своим подтверждением. */
  machine: Partial<Record<Locale, string>>;
  recipients: number;
  orgs: number;
  locales: Locale[];
};

/** Окно подтверждения: текст, машинные переводы, "Получат: N обращений, M организаций". Нет такого черновика: null. */
export async function broadcastDraft(ctx: StaffContext, broadcastId: unknown): Promise<BroadcastDraft | null> {
  if (ctx.actor.type !== 'staff') throw new HdpError('forbidden');
  const id = z.uuid().safeParse(broadcastId);
  if (!id.success) return null;
  return withActor(ctx.actor, async (tx) => {
    const [row] = await tx.select().from(broadcasts).where(eq(broadcasts.broadcastId, id.data)).limit(1);
    if (!row) return null;
    const list = await recipientsTx(tx, row.problemId);
    return { broadcastId: row.broadcastId, kind: row.kind, status: row.status, sourceLocale: row.sourceLocale, body: row.body[row.sourceLocale] ?? '', machine: row.machine, ...summary(list) };
  });
}

/**
 * Подтверждение (решения 17, 18, 20). translations: текст на каждый язык получателей, кроме языка оригинала; машинный
 * перевод уходит только так, через окно подтверждения. Нет текста на языке и нет флажка: translation_required.
 */
export async function confirmBroadcast(ctx: StaffContext, input: unknown): Promise<{ recipients: number }> {
  requireWriter(ctx);
  const data = parseInput(confirmInput, input);
  const result = await withActor(ctx.actor, async (tx) => {
    const [row] = await tx.select().from(broadcasts).where(eq(broadcasts.broadcastId, data.broadcastId)).limit(1).for('update');
    if (!row) throw new HdpError('not_found');
    if (row.status !== 'draft') throw new HdpError('broadcast_closed');
    const problem = await requireProblemTx(tx, { problemId: row.problemId }, { lock: true });
    if (problem.status === 'closed') throw new HdpError('problem_closed');
    const list = await recipientsTx(tx, problem.problemId);
    if (list.length === 0) throw new HdpError('no_recipients');
    const original = row.body[row.sourceLocale] ?? '';
    const body: Partial<Record<Locale, string>> = { [row.sourceLocale]: original };
    for (const locale of summary(list).locales) {
      if (locale === row.sourceLocale) continue;
      const text = data.translations[locale]?.trim();
      if (text) body[locale] = text;
      else if (!data.fallbackToOriginal) throw new HdpError('translation_required');
    }
    // Текст ещё раз проверяется на данные клиентов: среди получателей могли появиться новые организации.
    await assertPublicText(ctx.actor, tx, problem.problemId, Object.values(body));
    const { recipients, orgs } = summary(list);
    await tx
      .update(broadcasts)
      .set({ body, recipientIds: list.map((r) => r.ticketId), recipientsCount: recipients, orgCount: orgs, confirmedOn: new Date(), status: 'queued' })
      .where(and(eq(broadcasts.broadcastId, row.broadcastId), eq(broadcasts.status, 'draft')));
    await writeAudit(tx, { action: 'problem.broadcast_confirmed', objectType: 'problem', objectId: problem.problemId, diff: { number: problem.number, kind: row.kind, recipients, orgs } });
    if (row.kind === 'closing') {
      await updateProblemTx(tx, problem.problemId, { status: 'closed' });
      await writeAudit(tx, { action: 'problem.status_changed', objectType: 'problem', objectId: problem.problemId, diff: { number: problem.number, from: problem.status, to: 'closed' } });
    }
    return { recipients };
  });
  await enqueue('problems.broadcast', { broadcastId: data.broadcastId });
  return result;
}

export type BroadcastRow = {
  broadcastId: string;
  kind: BroadcastKind;
  status: BroadcastStatus;
  authorId: string;
  recipientsCount: number;
  orgCount: number;
  deliveredCount: number;
  createdOn: Date;
  confirmedOn: Date | null;
  sentOn: Date | null;
  body: string;
};

/** История рассылок карточки (вкладка "Обновления", FR-ADM-12): подтверждённые, новые сверху. */
export async function listBroadcasts(ctx: StaffContext, problemNumber: number): Promise<BroadcastRow[]> {
  if (ctx.actor.type !== 'staff') throw new HdpError('forbidden');
  return withActor(ctx.actor, async (tx) => {
    const problem = await requireProblemTx(tx, { number: problemNumber }).catch(() => null);
    if (!problem) return [];
    const rows = await tx.select().from(broadcasts).where(eq(broadcasts.problemId, problem.problemId)).orderBy(desc(broadcasts.createdOn));
    return rows
      .filter((r) => r.status !== 'draft')
      .map((r) => ({
        broadcastId: r.broadcastId,
        kind: r.kind,
        status: r.status,
        authorId: r.authorId,
        recipientsCount: r.recipientsCount,
        orgCount: r.orgCount,
        deliveredCount: r.deliveredCount,
        createdOn: r.createdOn,
        confirmedOn: r.confirmedOn,
        sentOn: r.sentOn,
        body: r.body[r.sourceLocale] ?? '',
      }));
  });
}
