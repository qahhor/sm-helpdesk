import 'server-only';
import { eq } from 'drizzle-orm';
import * as z from 'zod';
import { type SystemActor, withActor } from '@/db/with-actor';
import { isLocale, LOCALES } from '@/i18n/locales';
import { logEvent } from '@/lib/log';
import { requestPublicTextTranslation } from '@/modules/hda/api/translate';
import { comparePlainInvariants } from '@/modules/hdk/api/text-checks';
import { wakeOutbox } from '@/modules/hdn/api/outbox';
import { problemTicketsTx } from '@/modules/hdt/api/known-problems';
import { broadcastDeliveredTx, postProblemMessageTx } from '@/modules/hdt/api/problem-messages';
import { requireProblemTx } from '../core/problems';
import { broadcasts } from '../schema';
import { problemRef } from '../util';

// Модуль hdp, слой api: задачи фонового процесса рассылки (ТЗ 11.14; план M5c, задача 5, решения 17, 18, 20). Узкий
// файл без страниц и Next.js.
//
// problems.broadcast: по одному обращению из получателей подтверждения за транзакцию; сообщение только из текста
// рассылки на языке обращения (T23). Повтор и вторая одновременная задача не создают дублей: пару "обращение,
// рассылка" держит уникальный индекс, при конфликте ни письма, ни перехода. Сбой посреди рассылки бросается дальше:
// pg-boss повторяет задачу, доставленные пропускаются. По окончании статус done и число доставленных.

const SOURCE_FALLBACK = 'ru';

type Hook = () => void;
const hooks = globalThis as typeof globalThis & { __hubBroadcastHook?: Hook };

/** Подмена для тестов: вызывается перед каждой доставкой (сбой посреди рассылки). null убирает. */
export function setBroadcastHookForTests(hook: Hook | null): void {
  hooks.__hubBroadcastHook = hook ?? undefined;
}

const broadcastJob = z.strictObject({ broadcastId: z.uuid() });

export async function runBroadcastJob(system: SystemActor, data: unknown): Promise<{ delivered: number; skipped: number }> {
  const { broadcastId } = broadcastJob.parse(data);
  const loaded = await withActor(system, async (tx) => {
    const [row] = await tx.select().from(broadcasts).where(eq(broadcasts.broadcastId, broadcastId)).limit(1);
    if (!row || row.status === 'draft') return null;
    if (row.status === 'queued') await tx.update(broadcasts).set({ status: 'sending' }).where(eq(broadcasts.broadcastId, broadcastId));
    const problem = await requireProblemTx(tx, { problemId: row.problemId });
    const locales = new Map((await problemTicketsTx(tx, row.problemId)).map((t) => [t.ticketId, t.locale]));
    return { row, problem, locales };
  });
  if (!loaded) return { delivered: 0, skipped: 0 };
  const { row, problem, locales } = loaded;
  const original = row.body[row.sourceLocale] ?? '';
  let delivered = 0;
  let skipped = 0;
  for (const ticketId of row.recipientIds) {
    hooks.__hubBroadcastHook?.();
    const locale = locales.get(ticketId) ?? SOURCE_FALLBACK;
    const body = (isLocale(locale) ? row.body[locale] : undefined) ?? original;
    const result = await withActor(system, (tx) =>
      postProblemMessageTx(tx, {
        ticketId,
        problemId: row.problemId,
        broadcastId,
        authorId: row.authorId,
        body,
        problemRef: problemRef(problem.number),
        problemStatus: row.kind === 'closing' ? 'fixed' : problem.status,
        // Версия из задачи разработки проблемы появится с задачей 8: до неё итог "Решено".
        resolve: row.kind === 'closing' ? { resolutionType: 'solved', version: null } : null,
      }),
    );
    if (result === 'delivered') delivered += 1;
    else if (result === 'skipped') skipped += 1;
  }
  await withActor(system, async (tx) => {
    const done = await broadcastDeliveredTx(tx, broadcastId);
    await tx.update(broadcasts).set({ status: 'done', deliveredCount: done.delivered, sentOn: new Date() }).where(eq(broadcasts.broadcastId, broadcastId));
  });
  await wakeOutbox();
  return { delivered, skipped };
}

const translateJob = z.strictObject({ broadcastId: z.uuid(), locale: z.enum(LOCALES) });

/**
 * Машинный перевод рассылки на язык получателей (решение 17): в колонку machine черновика для окна подтверждения.
 * Клиенту он уходит, только если сотрудник отправит его своим подтверждением. Подтверждённую рассылку задача не трогает.
 */
export async function runBroadcastTranslationJob(system: SystemActor, data: unknown): Promise<void> {
  const { broadcastId, locale } = translateJob.parse(data);
  const row = await withActor(system, async (tx) => (await tx.select().from(broadcasts).where(eq(broadcasts.broadcastId, broadcastId)).limit(1))[0] ?? null);
  if (!row || row.status !== 'draft' || row.sourceLocale === locale) return;
  const original = row.body[row.sourceLocale] ?? '';
  const outcome = await requestPublicTextTranslation(system, { purpose: 'problem_translation', refId: row.problemId, from: row.sourceLocale, to: locale, title: '', body: original });
  if (outcome.status !== 'ok') {
    logEvent('warn', 'problems.broadcast_translate_skipped', { broadcastId, locale, status: outcome.status });
    return;
  }
  if (comparePlainInvariants({ title: '', body: original }, { title: '', body: outcome.value.body }).length > 0) {
    logEvent('warn', 'problems.broadcast_translate_rejected', { broadcastId, locale });
    return;
  }
  await withActor(system, async (tx) => {
    const [current] = await tx.select({ machine: broadcasts.machine, status: broadcasts.status }).from(broadcasts).where(eq(broadcasts.broadcastId, broadcastId)).limit(1).for('update');
    if (!current || current.status !== 'draft') return;
    await tx.update(broadcasts).set({ machine: { ...current.machine, [locale]: outcome.value.body.slice(0, 5000) } }).where(eq(broadcasts.broadcastId, broadcastId));
  });
}
