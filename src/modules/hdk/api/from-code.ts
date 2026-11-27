import 'server-only';
import { eq, gte, isNotNull, and, count } from 'drizzle-orm';
import * as z from 'zod';
import type { Tx } from '@/db/client';
import type { StaffActor } from '@/db/with-actor';
import { LOCALES } from '@/i18n/locales';
import { writeAudit } from '@/modules/hdc/api';
import { createDraftTx } from '../core/articles';
import { bindSignatureTx } from '../core/signatures';
import { draftIntoTemplate } from '../draft';
import { HdkError } from '../error';
import { KB_WRITER_ROLES } from '../pref';
import { kbArticles } from '../schema';
import { solutionTemplate, type TemplateLabels } from '../template';

// Модуль hdk, слой api: черновик решения из записи каталога ошибок (веха M8c, задача 6; ТЗ 7.22 FR-CODE-07, 15,
// FR-SOL-04; план M8c, решение 17). Для модуля hda, в транзакции сотрудника: черновик с аудиторией internal (на
// clients сотрудник меняет сам), признаком недоверенного текста (текст писал агент), ссылкой на запись и сигнатурой
// записи. Внутренних имён в черновике нет: модуль hda передаёт только заголовок из шаблона, причину и "что проверить".
// Публикует сотрудник обычным порядком FR-SOL-04, 05; до публикации решения нет в поиске, подсказка и помощник его не
// находят. После публикации помощник покажет его точным совпадением сигнатуры (сценарий S11, шаг 5).

const draftInput = z.strictObject({
  locale: z.enum(LOCALES),
  title: z.string().trim().min(1).max(140),
  problem: z.string().max(2000),
  steps: z.array(z.string().max(500)).max(12),
  moduleId: z.uuid().nullable(),
  entryId: z.uuid(),
  entryKey: z.string().min(1).max(120),
  signature: z.string().regex(/^[0-9a-f]{32}$/),
  sampleCode: z.string().max(80),
  sample: z.string().max(300),
});

export type CodeSolutionOutcome = { articleId: string; number: number; signature: 'bound' | 'taken' };

/** Черновик решения из записи одной транзакцией вызывающего. Сигнатура другого решения не перехватывается. */
export async function createSolutionFromCodeEntryTx(tx: Tx, actor: StaffActor, input: z.input<typeof draftInput>, labels: TemplateLabels, newId: () => string): Promise<CodeSolutionOutcome> {
  if (actor.type !== 'staff' || !(KB_WRITER_ROLES as readonly string[]).includes(actor.staffRole)) throw new HdkError('forbidden');
  const parsed = draftInput.safeParse(input);
  if (!parsed.success) throw new HdkError('invalid_input');
  const data = parsed.data;
  const doc = draftIntoTemplate(solutionTemplate(labels, newId), { problem: data.problem, steps: data.steps }, newId);
  const article = await createDraftTx(tx, { locale: data.locale, title: data.title, audience: 'internal', moduleId: data.moduleId, ownerId: actor.userId, doc });
  await tx.update(kbArticles).set({ isUntrusted: true, codeEntryId: data.entryId }).where(eq(kbArticles.articleId, article.articleId));
  const bound = await bindSignatureTx(tx, article.articleId, { signature: data.signature, code: data.sampleCode, sample: data.sample });
  await writeAudit(tx, { action: 'solution.created_from_code', objectType: 'solution', objectId: article.articleId, diff: { number: article.number, entry: data.entryKey } });
  return { articleId: article.articleId, number: article.number, signature: bound.status === 'bound' ? 'bound' : 'taken' };
}

/** Сколько решений создано из записей каталога с даты (FR-CODE-15). В транзакции вызывающего. */
export async function solutionsFromCodeEntriesTx(tx: Tx, since: Date): Promise<number> {
  const [row] = await tx.select({ n: count() }).from(kbArticles).where(and(isNotNull(kbArticles.codeEntryId), gte(kbArticles.createdOn, since)));
  return row?.n ?? 0;
}
