import 'server-only';
import * as z from 'zod';
import { withActor } from '@/db/with-actor';
import { LOCALES, type Locale } from '@/i18n/locales';
import type { StaffContext } from '@/modules/hdc/api';
import type { ClientContext } from '@/modules/hdu/api/orgs';
import { createDraftTx, publishedByNumberTx } from '../core/articles';
import { safeParseSolutionDoc, solutionDocSchema, type SolutionDoc } from '../doc-schema';
import { HdkError } from '../error';
import { ARTICLE_NUMBER_MAX, KB_AUDIENCES, KB_WRITER_ROLES, type KbAudience, TITLE_MAX } from '../pref';

// Модуль hdk, слой api: черновик решения и чтение опубликованного решения (план M5, задача 2). Редактор, автосохранение,
// публикация и страницы появятся в задачах 3 и 4 и будут строиться на этих функциях.
//
// Права проверяются дважды: здесь по роли актора и в базе политиками (решение 10). Клиент получает текст решения только
// из hdk_published (ТЗ 10.5): эта функция другой таблицы для него не читает, а документ перед выдачей снова проходит
// схему, чтобы страница рисовала только закрытый список блоков.

export type { SolutionDoc } from '../doc-schema';

function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const parsed = schema.safeParse(input);
  if (!parsed.success) throw new HdkError('invalid_input');
  return parsed.data;
}

const locale = z.enum(LOCALES);
const draftInput = z.strictObject({
  locale,
  title: z.string().trim().max(TITLE_MAX),
  audience: z.enum(KB_AUDIENCES),
  moduleId: z.uuid().optional(),
  doc: solutionDocSchema,
});
const publishedInput = z.strictObject({ number: z.int().positive().max(ARTICLE_NUMBER_MAX), locale });

/** Новое решение: статья и черновик на языке оригинала. Создают agent_l1, agent_l2, care, admin. */
export async function createDraftArticle(ctx: StaffContext, input: unknown): Promise<{ articleId: string; number: number; versionId: string }> {
  if (ctx.actor.type !== 'staff' || !(KB_WRITER_ROLES as readonly string[]).includes(ctx.actor.staffRole)) throw new HdkError('forbidden');
  const data = parse(draftInput, input);
  return withActor(ctx.actor, (tx) => createDraftTx(tx, { ...data, moduleId: data.moduleId ?? null, ownerId: ctx.actor.userId }));
}

export type PublishedSolution = {
  articleId: string;
  number: number;
  locale: Locale;
  originalLocale: Locale;
  audience: KbAudience;
  title: string;
  slug: string;
  doc: SolutionDoc;
  moduleIds: string[];
  fileIds: string[];
  isMachine: boolean;
  isOutdated: boolean;
  publishedOn: Date;
};

/**
 * Опубликованное решение по номеру и языку от имени читателя. Клиенту база отдаёт только решения для клиентов;
 * черновик, архивное и внутреннее решение для него не существуют (null). Документ, не прошедший схему, не отдаётся.
 */
export async function readPublishedSolution(ctx: Pick<ClientContext, 'actor'> | StaffContext, input: unknown): Promise<PublishedSolution | null> {
  const data = parse(publishedInput, input);
  const row = await withActor(ctx.actor, (tx) => publishedByNumberTx(tx, data.number, data.locale));
  if (!row) return null;
  const doc = safeParseSolutionDoc(row.doc);
  if (!doc.success) return null;
  return {
    articleId: row.articleId,
    number: row.articleNumber,
    locale: row.locale,
    originalLocale: row.originalLocale,
    audience: row.audience,
    title: row.title,
    slug: row.slug,
    doc: doc.data,
    moduleIds: row.moduleIds,
    fileIds: row.fileIds,
    isMachine: row.isMachine,
    isOutdated: row.isOutdated,
    publishedOn: row.publishedOn,
  };
}
