import 'server-only';
import { and, eq, inArray } from 'drizzle-orm';
import type { Tx } from '@/db/client';
import type { Locale } from '@/i18n/locales';
import { ideas, ideaTranslations } from '../schema';

// Модуль hdi, слой core: что идея отдаёт в поисковый индекс похожих (план M7, задача 3, решение 23). Только
// опубликованная идея в голосовании, отборе, работе или выпущенная; на модерации, отклонённая и объединённая в индексе
// не лежат. Тексты: оригинал, машинный перевод, прошедший сверку, и проверенный модератором; без автора и организации.

const INDEXED_STATUSES = ['open', 'shortlisted', 'selected', 'in_development', 'released'] as const;

export async function ideaIndexSourceTx(tx: Tx, ideaId: string): Promise<{ moduleId: string | null; texts: { locale: Locale; title: string; body: string }[] }> {
  const [idea] = await tx.select({ moduleId: ideas.moduleId, status: ideas.status }).from(ideas).where(eq(ideas.ideaId, ideaId)).limit(1);
  if (!idea || !(INDEXED_STATUSES as readonly string[]).includes(idea.status)) return { moduleId: idea?.moduleId ?? null, texts: [] };
  const texts = await tx
    .select({ locale: ideaTranslations.locale, title: ideaTranslations.title, body: ideaTranslations.body })
    .from(ideaTranslations)
    .where(and(eq(ideaTranslations.ideaId, ideaId), inArray(ideaTranslations.status, ['original', 'machine', 'reviewed'])));
  return { moduleId: idea.moduleId, texts };
}
