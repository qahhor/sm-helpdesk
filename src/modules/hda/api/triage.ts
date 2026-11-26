import 'server-only';
import * as z from 'zod';
import type { Tx } from '@/db/client';
import { withActor } from '@/db/with-actor';
import { LOCALES, type Locale } from '@/i18n/locales';
import { FRESH_SIGN_IN_SEC, isFresh, type StaffContext, writeAudit } from '@/modules/hdc/api';
import { readPublishedSolution } from '@/modules/hdk/api/articles';
import { activeFieldOffsTx, latestFoundTx, liftFieldOffTx, markSuggestionsTx, type SuggestionRow, suggestionsTx } from '../core/triage';
import { HdaError } from '../error';
import type { TriageField } from '../pref';

// Модуль hda, слой api: блок AI у сотрудника и решения по предложениям разбора (план M5b, задача 7; FR-TRI-02, FR-AI-13,
// UX-A-12). Только сотрудники: клиент таблицу предложений не видит и этот файл не вызывает (FR-TRI-06). Поля обращения
// меняет модуль hdt (acceptTriage) в своей транзакции, вызывая функции *Tx отсюда: решение и изменение поля одной
// транзакцией.

export type { SuggestionRow } from '../core/triage';

function requireStaff(ctx: StaffContext): void {
  if (ctx?.actor?.type !== 'staff') throw new HdaError('forbidden');
}

export type TriageBlockView = {
  suggestions: SuggestionRow[];
  /** Найденные первой линией решения: номер, оценка, заголовок из hdk_published на языке обращения. */
  found: { number: number; score: number; title: string | null }[];
};

/** Блок AI у сотрудника: предложения разбора и найденные решения последнего вызова первой линии. */
export async function triageBlock(ctx: StaffContext, input: unknown, opts: { locale?: string } = {}): Promise<TriageBlockView> {
  requireStaff(ctx);
  const parsed = z.strictObject({ ticketId: z.uuid() }).safeParse(input);
  if (!parsed.success) throw new HdaError('invalid_input');
  const { suggestions, found } = await withActor(ctx.actor, async (tx) => ({ suggestions: await suggestionsTx(tx, parsed.data.ticketId), found: await latestFoundTx(tx, parsed.data.ticketId) }));
  const locale: Locale = (LOCALES as readonly string[]).includes(opts.locale ?? '') ? (opts.locale as Locale) : 'ru';
  const titled = await Promise.all(
    found.map(async (f) => ({ number: f.number, score: f.score, title: (await readPublishedSolution(ctx, { number: f.number, locale }).catch(() => null))?.title ?? null })),
  );
  return { suggestions, found: titled };
}

/** Ждущие предложения обращения под блокировкой для принятия; fields: какие поля, 'all': все ждущие. */
export async function pendingTriageTx(tx: Tx, ticketId: string, fields: readonly TriageField[] | 'all'): Promise<SuggestionRow[]> {
  const rows = await suggestionsTx(tx, ticketId, { lock: true });
  return rows.filter((r) => r.status === 'pending' && (fields === 'all' || fields.includes(r.field)));
}

export async function markTriageAcceptedTx(tx: Tx, ids: readonly string[], userId: string, now: Date): Promise<void> {
  await markSuggestionsTx(tx, ids, 'accepted', userId, now);
}

/** Поля, отключённые ночной задачей (FR-TRI-04): экран настроек AI показывает их с кнопкой "Включить снова". */
export async function triageFieldOffs(ctx: StaffContext): Promise<Awaited<ReturnType<typeof activeFieldOffsTx>>> {
  requireStaff(ctx);
  return withActor(ctx.actor, (tx) => activeFieldOffsTx(tx));
}

/** Включить поле обратно: администратор портала со свежим входом, запись в журнал аудита той же транзакцией. */
export async function liftTriageFieldOff(ctx: StaffContext, input: unknown): Promise<void> {
  if (ctx.actor.type !== 'staff' || ctx.actor.staffRole !== 'admin') throw new HdaError('forbidden');
  if (!isFresh(ctx, new Date(), FRESH_SIGN_IN_SEC)) throw new HdaError('stale_session');
  const parsed = z.strictObject({ offId: z.uuid() }).safeParse(input);
  if (!parsed.success) throw new HdaError('invalid_input');
  await withActor(ctx.actor, async (tx) => {
    const row = await liftFieldOffTx(tx, parsed.data.offId, ctx.actor.userId);
    if (!row) throw new HdaError('invalid_input');
    await writeAudit(tx, { action: 'settings.changed', objectType: 'setting', objectId: 'ai.triage_field_off', diff: { lifted: parsed.data.offId, field: row.field } });
  });
}
