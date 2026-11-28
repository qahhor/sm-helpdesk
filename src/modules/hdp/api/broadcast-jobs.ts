import 'server-only';
import { and, eq, inArray, lt } from 'drizzle-orm';
import * as z from 'zod';
import { type SystemActor, withActor } from '@/db/with-actor';
import { isLocale, LOCALES } from '@/i18n/locales';
import { logEvent } from '@/lib/log';
import { enqueue } from '@/modules/hdc/api';
import { requestPublicTextTranslation } from '@/modules/hda/api/translate';
import { comparePlainInvariants } from '@/modules/hdk/api/text-checks';
import { wakeOutbox } from '@/modules/hdn/api/outbox';
import { problemTicketsTx } from '@/modules/hdt/api/known-problems';
import { broadcastDeliveredTx, postProblemMessageTx } from '@/modules/hdt/api/problem-messages';
import { problemDevTaskVersionTx } from '../dev-task-version';
import { requireProblemTx } from '../core/problems';
import { broadcasts } from '../schema';
import { problemRef } from '../util';
import { withActorForTicket } from '@/modules/hdt/api/notice-identity';

// Модуль hdp, слой api: задачи фонового процесса рассылки (ТЗ 11.14; план M5c, задача 5, решения 17, 18, 20). Узкий
// файл без страниц и Next.js.
//
// problems.broadcast: по одному обращению из получателей подтверждения за транзакцию; сообщение только из текста
// рассылки на языке обращения (T23). Повтор и вторая одновременная задача не создают дублей: пару "обращение,
// рассылка" держит уникальный индекс, при конфликте ни письма, ни перехода. Сбой на одном обращении не отнимает
// сообщение у остальных (проверка качества, Q1): задача доходит до конца списка, рассылка остаётся sending и задача
// падает, pg-boss её повторяет, доставленные пропускаются. По окончании без сбоев статус done и число доставленных.
//
// Обход sweepBroadcasts (минутная задача tickets.minute): подтверждённая рассылка, которая за 10 минут не дошла до
// done, ставится снова. Так переживается потеря постановки после транзакции подтверждения и исчерпанные повторы.
// Рассылка, висящая дольше 30 минут, даёт сигнал дежурным broadcast_stuck (ops.watch).
//
// Получатель, который падает всегда (независимая проверка, B8; решение 0173): повтор задачи читает, кому сообщение
// уже доставлено, и до снимка получателей и транзакции доходит только с остальными; обход ставит такую рассылку всё
// реже (requeueDue). Счётчика попыток и конечного состояния "доставлено частично" у рассылки нет: рассылка остаётся
// sending, сигнал broadcast_stuck идёт, пока причину не устранят.

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
    // Итог закрытия (решения 20, 25): версия задачи разработки проблемы, если она известна, иначе "Решено".
    const version = row.kind === 'closing' ? await problemDevTaskVersionTx(tx, row.problemId) : null;
    // Кому сообщение этой рассылки уже доставлено (повтор задачи): их обращения запуск не трогает.
    const already = (await broadcastDeliveredTx(tx, broadcastId)).ticketIds;
    return { row, problem, locales, version, already };
  });
  if (!loaded) return { delivered: 0, skipped: 0 };
  const { row, problem, locales, version, already } = loaded;
  const original = row.body[row.sourceLocale] ?? '';
  let delivered = 0;
  let skipped = 0;
  const failures: unknown[] = [];
  for (const ticketId of row.recipientIds) {
    // Доставленное раньше: ни снимка получателей, ни транзакции. Дубль в любом случае не пускает уникальный индекс.
    if (already.has(ticketId)) continue;
    try {
      hooks.__hubBroadcastHook?.();
      const locale = locales.get(ticketId) ?? SOURCE_FALLBACK;
      const body = (isLocale(locale) ? row.body[locale] : undefined) ?? original;
      // Получатели письма читаются до транзакции обращения (проверка качества, Q2).
      const result = await withActorForTicket(system, { ticketId }, (tx) =>
        postProblemMessageTx(tx, {
          ticketId,
          problemId: row.problemId,
          broadcastId,
          authorId: row.authorId,
          body,
          problemRef: problemRef(problem.number),
          problemStatus: row.kind === 'closing' ? 'fixed' : problem.status,
          resolve: row.kind === 'closing' ? (version ? { resolutionType: 'fixed_in_version', version } : { resolutionType: 'solved', version: null }) : null,
        }),
      );
      if (result === 'delivered') delivered += 1;
      else if (result === 'skipped') skipped += 1;
    } catch (error) {
      // В журнале только идентификаторы: текст ошибки базы может нести данные обращения.
      failures.push(error);
      logEvent('error', 'problems.broadcast_recipient_failed', { broadcastId, ticketId });
    }
  }
  if (failures.length > 0) {
    // Письма доставленным уже в очереди исходящих. Рассылка остаётся sending: повтор задачи или обход доставит остальным.
    await wakeOutbox();
    const first = failures[0];
    throw new Error(`рассылка ${broadcastId}: не доставлено обращениям ${failures.length} из ${row.recipientIds.length}: ${first instanceof Error ? first.message : 'сбой'}`, { cause: first });
  }
  await withActor(system, async (tx) => {
    const done = await broadcastDeliveredTx(tx, broadcastId);
    await tx.update(broadcasts).set({ status: 'done', deliveredCount: done.delivered, sentOn: new Date() }).where(eq(broadcasts.broadcastId, broadcastId));
  });
  await wakeOutbox();
  return { delivered, skipped };
}

/** Подтверждённая рассылка без done старше этого срока ставится снова. */
export const BROADCAST_REQUEUE_AFTER_MIN = 10;
/** Старше этого срока: сигнал дежурным broadcast_stuck. */
export const BROADCAST_STUCK_AFTER_MIN = 30;
const SWEEP_LIMIT = 50;

const unfinishedBefore = (now: Date, minutes: number) =>
  and(inArray(broadcasts.status, ['queued', 'sending']), lt(broadcasts.confirmedOn, new Date(now.getTime() - minutes * 60_000)));

/** Обход идёт раз в минуту: это окно, за которое он проверяет, наступил ли срок очередной постановки. */
const SWEEP_PERIOD_MS = 60_000;

/**
 * Пора ли ставить зависшую рассылку снова (независимая проверка, B8). Пауза растёт с возрастом рассылки: первый час
 * после подтверждения каждый обход, до суток раз в 10 минут, дальше раз в час. Счётчика попыток у рассылки нет, срок
 * считается от времени подтверждения: постановка идёт на обходе, который первым перешёл границу шага. Обход,
 * пришедший позже чем через минуту после прежнего, может границу пропустить: тогда рассылка ждёт ещё один шаг.
 */
export function requeueDue(ageMs: number): boolean {
  const stepMs = (ageMs < 3_600_000 ? 1 : ageMs < 86_400_000 ? 10 : 60) * 60_000;
  return Math.floor(ageMs / stepMs) !== Math.floor((ageMs - SWEEP_PERIOD_MS) / stepMs);
}

/**
 * Обход зависших рассылок (проверка качества, Q1): queued и sending старше 10 минут ставятся на отправку снова, чем
 * старше рассылка, тем реже (requeueDue). Задача идемпотентна, вторая одновременная дублей не создаёт.
 */
export async function sweepBroadcasts(system: SystemActor, now: Date = new Date()): Promise<{ requeued: number }> {
  const rows = await withActor(system, (tx) =>
    tx
      .select({ broadcastId: broadcasts.broadcastId, confirmedOn: broadcasts.confirmedOn })
      .from(broadcasts)
      .where(unfinishedBefore(now, BROADCAST_REQUEUE_AFTER_MIN))
      .orderBy(broadcasts.confirmedOn)
      .limit(SWEEP_LIMIT),
  );
  const due = rows.filter((row) => row.confirmedOn !== null && requeueDue(now.getTime() - new Date(row.confirmedOn).getTime()));
  for (const row of due) await enqueue('problems.broadcast', { broadcastId: row.broadcastId });
  return { requeued: due.length };
}

/** Сколько подтверждённых рассылок не дошли до конца за 30 минут (сигнал broadcast_stuck задачи ops.watch). */
export async function stuckBroadcastCount(system: SystemActor, now: Date): Promise<number> {
  const rows = await withActor(system, (tx) =>
    tx.select({ broadcastId: broadcasts.broadcastId }).from(broadcasts).where(unfinishedBefore(now, BROADCAST_STUCK_AFTER_MIN)).limit(100),
  );
  return rows.length;
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
