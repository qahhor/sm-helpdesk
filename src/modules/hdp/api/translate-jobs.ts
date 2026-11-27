import 'server-only';
import * as z from 'zod';
import { type SystemActor, withActor } from '@/db/with-actor';
import { LOCALES } from '@/i18n/locales';
import { logEvent } from '@/lib/log';
import { writeAudit } from '@/modules/hdc/api';
import { requestPublicTextTranslation } from '@/modules/hda/api/translate';
import { comparePlainInvariants } from '@/modules/hdk/api/text-checks';
import { unlinkedTicketIdsTx } from '@/modules/hdt/api/known-problems';
import { linkTicketTx } from '../core/links';
import { activeProblemBySignatureTx, insertProblemTx, insertSignatureTx, requireProblemTx, translationsTx, upsertTranslationTx } from '../core/problems';
import { HdpError } from '../error';
import { draftInput, parseInput } from '../input';
import { and, eq } from 'drizzle-orm';
import { announcements, announcementTranslations } from '../schema';

// Модуль hdp, слой api: задачи фонового процесса (план M5c, задача 2). Узкий файл без страниц и Next.js.
//
// problems.translate: машинный перевод публичного текста проблемы на язык (решение 17). В модель уходит только текст
// сотрудника на языке оригинала (раздел 14.3), он уже прошёл проверку checkPublicText. Перевод ложится строкой с
// пометкой машинного: клиенту он не виден, пока сотрудник его не принял. Текст сотрудника на этом языке задача не
// трогает. Перевод, потерявший ссылки или числа оригинала, не сохраняется: сотрудник переводит сам. Сбой модели
// бросается дальше, pg-boss повторяет задачу.

const translateJob = z.strictObject({ problemId: z.uuid(), locale: z.enum(LOCALES) });

export async function runProblemTranslationJob(system: SystemActor, data: unknown): Promise<void> {
  const { problemId, locale } = translateJob.parse(data);
  const source = await withActor(system, async (tx) => {
    const problem = await requireProblemTx(tx, { problemId }).catch(() => null);
    if (!problem || problem.status === 'closed' || problem.sourceLocale === locale) return null;
    const texts = await translationsTx(tx, problemId);
    const original = texts.find((t) => t.locale === problem.sourceLocale && !t.isMachine);
    const target = texts.find((t) => t.locale === locale);
    // Сотрудник уже написал этот язык сам: перевод не нужен.
    if (!original || original.publicTitle === '' || (target && !target.isMachine)) return null;
    return { problem, original };
  });
  if (!source) return;
  const outcome = await requestPublicTextTranslation(system, {
    purpose: 'problem_translation',
    refId: problemId,
    from: source.problem.sourceLocale,
    to: locale,
    title: source.original.publicTitle,
    body: source.original.publicBody,
  });
  if (outcome.status !== 'ok') {
    logEvent('warn', 'problems.translate_skipped', { problemId, locale, status: outcome.status });
    return;
  }
  const original = { title: source.original.publicTitle, body: source.original.publicBody };
  if (comparePlainInvariants(original, outcome.value).length > 0) {
    logEvent('warn', 'problems.translate_rejected', { problemId, locale });
    return;
  }
  await withActor(system, async (tx) => {
    const current = (await translationsTx(tx, problemId)).find((t) => t.locale === locale);
    if (current && !current.isMachine) return;
    await upsertTranslationTx(tx, { problemId, locale, publicTitle: outcome.value.title.trim().slice(0, 200), publicBody: outcome.value.body.slice(0, 5000), isMachine: true, acceptedBy: null });
  });
}

/**
 * Черновик проблемы для будущего инструмента AI-сотрудника (FR-AGT-11, веха M8b): без признака показа и публичного
 * текста, только сигнатура и привязка обращений. Обращение уже с другой проблемой, закрытое и из "Неопознанных"
 * пропускается. Сигнатура занята другой активной проблемой: отказ signature_taken (это не всплеск, а известная проблема).
 */
export async function createProblemDraft(system: SystemActor, input: unknown): Promise<{ number: number; linked: number }> {
  const data = parseInput(draftInput, input);
  return withActor(system, async (tx) => {
    if (await activeProblemBySignatureTx(tx, data.signature)) throw new HdpError('signature_taken');
    const { problemId, number } = await insertProblemTx(tx, { internalTitle: data.internalTitle, moduleId: null, ownerId: null });
    await insertSignatureTx(tx, { problemId, signature: data.signature, addedBy: null });
    await writeAudit(tx, { action: 'problem.created', objectType: 'problem', objectId: problemId, diff: { number, draft: true } });
    let linked = 0;
    for (const ticketId of await unlinkedTicketIdsTx(tx, data.ticketIds)) {
      // Каждое обращение проверяется общей функцией привязки; отказ одного не отменяет остальные.
      const outcome = await linkSafely(() => linkTicketTx(tx, system, { ticket: { ticketId }, problem: { problemId }, via: 'manual' }));
      if (outcome) linked += 1;
    }
    return { number, linked };
  });
}

/** Отказ модуля (закрытое обращение и подобное) не рушит черновик; ошибка базы рушит. */
async function linkSafely(fn: () => Promise<unknown>): Promise<boolean> {
  try {
    await fn();
    return true;
  } catch (error) {
    if (error instanceof HdpError) return false;
    throw error;
  }
}

// --- announcements.translate (задача 6, решение 24) ---

const announcementJob = z.strictObject({ announcementId: z.uuid(), locale: z.enum(LOCALES) });

/**
 * Машинный перевод объявления на язык: строка с пометкой машинного, клиенту не видна до принятия сотрудником. Текст
 * сотрудника на этом языке задача не трогает. Перевод, потерявший ссылки или числа, не сохраняется.
 */
export async function runAnnouncementTranslationJob(system: SystemActor, data: unknown): Promise<void> {
  const { announcementId, locale } = announcementJob.parse(data);
  const source = await withActor(system, async (tx) => {
    const [head] = await tx.select().from(announcements).where(eq(announcements.announcementId, announcementId)).limit(1);
    if (!head || head.sourceLocale === locale || head.endsOn <= new Date()) return null;
    const texts = await tx.select().from(announcementTranslations).where(eq(announcementTranslations.announcementId, announcementId));
    const original = texts.find((t) => t.locale === head.sourceLocale && !t.isMachine);
    const target = texts.find((t) => t.locale === locale);
    if (!original || (target && !target.isMachine)) return null;
    return { head, original };
  });
  if (!source) return;
  const outcome = await requestPublicTextTranslation(system, {
    purpose: 'announcement_translation',
    refId: announcementId,
    from: source.head.sourceLocale,
    to: locale,
    title: source.original.title,
    body: source.original.body,
  });
  if (outcome.status !== 'ok') return;
  const original = { title: source.original.title, body: source.original.body };
  if (comparePlainInvariants(original, outcome.value).length > 0 || !outcome.value.title.trim()) {
    logEvent('warn', 'announcements.translate_rejected', { announcementId, locale });
    return;
  }
  await withActor(system, async (tx) => {
    const [current] = await tx
      .select({ isMachine: announcementTranslations.isMachine })
      .from(announcementTranslations)
      .where(and(eq(announcementTranslations.announcementId, announcementId), eq(announcementTranslations.locale, locale)))
      .limit(1);
    if (current && !current.isMachine) return;
    const text = { title: outcome.value.title.trim().slice(0, 200), body: outcome.value.body.slice(0, 3000), isMachine: true, acceptedBy: null, acceptedOn: null };
    await tx
      .insert(announcementTranslations)
      .values({ announcementId, locale, ...text })
      .onConflictDoUpdate({ target: [announcementTranslations.announcementId, announcementTranslations.locale], set: text });
  });
}
