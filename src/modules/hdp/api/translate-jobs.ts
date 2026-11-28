import 'server-only';
import * as z from 'zod';
import { type SystemActor, withActor } from '@/db/with-actor';
import { LOCALES } from '@/i18n/locales';
import { logEvent } from '@/lib/log';
import { requestPublicTextTranslation } from '@/modules/hda/api/translate';
import { comparePlainInvariants } from '@/modules/hdk/api/text-checks';
import { problemTx, translationsTx, upsertTranslationTx } from '../core/problems';
import { createSystemProblemDraft } from './agent-drafts';
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
    // Проблемы может не быть: это ответ, а не ошибка. Ошибка базы не глотается (проверка качества, Q16).
    const problem = await problemTx(tx, { problemId });
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

/** Черновик проблемы от системы (всплеск сигнатуры): по решению 20 плана M8b обращения только предложены. */
export const createProblemDraft = createSystemProblemDraft;

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
