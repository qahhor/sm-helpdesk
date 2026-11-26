import 'server-only';
import { and, eq } from 'drizzle-orm';
import type { Tx } from '@/db/client';
import type { Locale } from '@/i18n/locales';
import { ideas, ideaTranslations } from '../schema';
import { originalTextTx, translationStateTx } from './moderate';

// Модуль hdi, слой core: машинный перевод идеи (ТЗ FR-IDEA-13; план M7, задача 4, решения 11, 12). Пишет задание
// ideas.translate от имени системы. Перевод модели ложится строкой machine (прошёл сверку) или rejected (не прошёл:
// клиент его не видит, политика). Проверенный модератором перевод того же оригинала не заменяется.

/** Что переводить: опубликованная идея в голосовании, отборе, работе или выпущенная; языки без годного перевода. */
export async function translationPlanTx(
  tx: Tx,
  ideaId: string,
  locales: readonly Locale[],
  hashOf: (title: string, body: string) => string,
): Promise<{ orgId: string; authorId: string; authorName: string; original: { locale: Locale; title: string; body: string }; sourceHash: string; targets: Locale[] } | null> {
  const [idea] = await tx
    .select({ orgId: ideas.orgId, authorId: ideas.authorId, authorName: ideas.authorName, status: ideas.status })
    .from(ideas)
    .where(eq(ideas.ideaId, ideaId))
    .limit(1);
  if (!idea || !['open', 'shortlisted', 'selected', 'in_development', 'released'].includes(idea.status)) return null;
  const original = await originalTextTx(tx, ideaId);
  if (!original) return null;
  const sourceHash = hashOf(original.title, original.body);
  const done = new Set((await translationStateTx(tx, ideaId)).filter((t) => (t.status === 'machine' || t.status === 'reviewed') && t.sourceHash === sourceHash).map((t) => t.locale));
  return { ...idea, original, sourceHash, targets: locales.filter((locale) => locale !== original.locale && !done.has(locale)) };
}

/** Перевод модели на один язык; строку reviewed с тем же оригиналом не трогает (правка модератора важнее). */
export async function writeMachineTranslationTx(
  tx: Tx,
  ideaId: string,
  locale: Locale,
  text: { title: string; body: string },
  status: 'machine' | 'rejected',
  sourceHash: string,
): Promise<boolean> {
  const [current] = await tx
    .select({ status: ideaTranslations.status, sourceHash: ideaTranslations.sourceHash })
    .from(ideaTranslations)
    .where(and(eq(ideaTranslations.ideaId, ideaId), eq(ideaTranslations.locale, locale)))
    .limit(1);
  if (current && (current.status === 'original' || (current.status === 'reviewed' && current.sourceHash === sourceHash))) return false;
  const values = { title: text.title, body: text.body, isMachine: true, status, sourceHash };
  await tx
    .insert(ideaTranslations)
    .values({ ideaId, locale, ...values })
    .onConflictDoUpdate({ target: [ideaTranslations.ideaId, ideaTranslations.locale], set: values });
  return true;
}
