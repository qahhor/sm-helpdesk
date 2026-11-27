import 'server-only';
import { and, eq, inArray } from 'drizzle-orm';
import * as z from 'zod';
import type { Tx } from '@/db/client';
import type { StaffActor } from '@/db/with-actor';
import { withActor } from '@/db/with-actor';
import { LOCALES } from '@/i18n/locales';
import { type StaffContext, writeAudit } from '@/modules/hdc/api';
import { createDraftTx } from '../core/articles';
import { articleByNumberTx, lockArticleTx, versionByIdTx } from '../core/editor';
import { untrustedFindings, untrustedTextHash } from '../core/untrusted';
import { safeParseSolutionDoc } from '../doc-schema';
import { draftIntoTemplate } from '../draft';
import { HdkError } from '../error';
import { KB_WRITER_ROLES } from '../pref';
import { kbArticles, kbArticleSources, kbArticleVersions } from '../schema';
import { solutionTemplate, type TemplateLabels } from '../template';

// Модуль hdk, слой api: решение из кандидата (ТЗ FR-CAND-04, 06, 09, FR-SOL-04, 05; план M5c, задача 10, решения 29, 30).
// Для модуля hda, в транзакции сотрудника: черновик решения с аудиторией internal (на clients сотрудник меняет сам
// перед публикацией), текст кандидата в заготовке, все обращения-источники в hdk_article_sources и признак
// is_untrusted. Публикация обычным порядком: проверка FR-SOL-04 и отметка каждой находки недоверенного текста.
// До публикации решения нет в поисковом индексе, подсказка и помощник его не находят (FR-CAND-06).

export type CandidateSource = { ticketId: string; orgId: string };

const draftInput = z.strictObject({
  locale: z.enum(LOCALES),
  title: z.string().trim().min(1).max(140),
  problem: z.string().max(1200),
  steps: z.array(z.string().max(500)).max(12),
  moduleId: z.uuid().nullable(),
  sources: z.array(z.strictObject({ ticketId: z.uuid(), orgId: z.uuid() })).min(1).max(1000),
});

/** Черновик решения из кандидата одной транзакцией вызывающего. Возвращает идентификатор и номер решения. */
export async function createSolutionFromCandidateTx(
  tx: Tx,
  actor: StaffActor,
  input: z.input<typeof draftInput>,
  labels: TemplateLabels,
  newId: () => string,
): Promise<{ articleId: string; number: number }> {
  if (actor.type !== 'staff' || !(KB_WRITER_ROLES as readonly string[]).includes(actor.staffRole)) throw new HdkError('forbidden');
  const parsed = draftInput.safeParse(input);
  if (!parsed.success) throw new HdkError('invalid_input');
  const data = parsed.data;
  const doc = draftIntoTemplate(solutionTemplate(labels, newId), { problem: data.problem, steps: data.steps }, newId);
  const article = await createDraftTx(tx, { locale: data.locale, title: data.title, audience: 'internal', moduleId: data.moduleId, ownerId: actor.userId, doc });
  await tx.update(kbArticles).set({ isUntrusted: true }).where(eq(kbArticles.articleId, article.articleId));
  await tx.insert(kbArticleSources).values(data.sources.map((s) => ({ ...s, articleId: article.articleId })));
  await writeAudit(tx, { action: 'solution.created_from_candidate', objectType: 'solution', objectId: article.articleId, diff: { number: article.number, sources: data.sources.length } });
  return { articleId: article.articleId, number: article.number };
}

/** Добавить обращения-источники к действующему решению по номеру (объединение кандидата, решение 29). Уже есть: пропуск. */
export async function addSolutionSourcesTx(tx: Tx, input: { articleNumber: number; sources: readonly CandidateSource[] }): Promise<{ articleId: string; added: number }> {
  const article = await articleByNumberTx(tx, input.articleNumber, { lock: true });
  if (!article || article.status !== 'active') throw new HdkError('not_found');
  const ids = input.sources.map((s) => s.ticketId);
  const existing = ids.length === 0 ? [] : await tx.select({ ticketId: kbArticleSources.ticketId }).from(kbArticleSources).where(and(eq(kbArticleSources.articleId, article.articleId), inArray(kbArticleSources.ticketId, ids)));
  const have = new Set(existing.map((r) => r.ticketId));
  const fresh = input.sources.filter((s) => !have.has(s.ticketId));
  if (fresh.length > 0) await tx.insert(kbArticleSources).values(fresh.map((s) => ({ ...s, articleId: article.articleId })));
  return { articleId: article.articleId, added: fresh.length };
}

const confirmInput = z.strictObject({ number: z.int().positive().max(999_999_999_999), locale: z.enum(LOCALES), versionId: z.uuid(), fingerprints: z.array(z.string().regex(/^[0-9a-f]{32}$/)).max(200) });

/**
 * Отметить находки недоверенного текста "Проверено" (решение 30): хранятся в версии вместе с отпечатком текста. Правка
 * текста меняет отпечаток, и отметки перестают действовать. Отмечаются только находки этого текста. Журнал аудита.
 */
export async function confirmUntrustedFindings(ctx: StaffContext, input: unknown): Promise<{ confirmed: number }> {
  if (ctx.actor.type !== 'staff' || !(KB_WRITER_ROLES as readonly string[]).includes(ctx.actor.staffRole)) throw new HdkError('forbidden');
  const parsed = confirmInput.safeParse(input);
  if (!parsed.success) throw new HdkError('invalid_input');
  const data = parsed.data;
  return withActor(ctx.actor, async (tx) => {
    const article = await articleByNumberTx(tx, data.number);
    if (!article) throw new HdkError('not_found');
    await lockArticleTx(tx, article.articleId);
    const version = await versionByIdTx(tx, article.articleId, data.locale, data.versionId, { lock: true });
    if (!version || version.state !== 'draft') throw new HdkError('not_found');
    const doc = safeParseSolutionDoc(version.doc);
    if (!doc.success) throw new HdkError('invalid_input');
    const content = { title: version.title, doc: doc.data };
    const known = new Set(untrustedFindings(content).map((f) => f.fingerprint));
    const fingerprints = [...new Set(data.fingerprints)].filter((f) => known.has(f));
    await tx.update(kbArticleVersions).set({ untrustedConfirmed: { textHash: untrustedTextHash(content), fingerprints } }).where(eq(kbArticleVersions.versionId, version.versionId));
    await writeAudit(tx, { action: 'solution.untrusted_confirmed', objectType: 'article', objectId: article.articleId, diff: { versionId: version.versionId, findings: fingerprints.length } });
    return { confirmed: fingerprints.length };
  });
}
