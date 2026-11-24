import 'server-only';
import * as z from 'zod';
import { withActor } from '@/db/with-actor';
import { LOCALES, type Locale } from '@/i18n/locales';
import type { StaffContext } from '@/modules/hdc/api';
import { articleByNumberTx, currentVersion, foreignFileIdsTx, type ListRow, listArticlesTx, restoreVersionTx, saveDraftTx, updateMetaTx, versionByIdTx, versionsTx } from '../core/editor';
import { type Review, reviewTx } from '../core/publish';
import { safeParseSolutionDoc, solutionDocSchema, type SolutionDoc } from '../doc-schema';
import { HdkError } from '../error';
import { readAllowedDomains } from './publish';
import {
  ARTICLE_NUMBER_MAX,
  KB_AUDIENCES,
  KB_PUBLISHER_ROLES,
  KB_WRITER_ROLES,
  type KbAudience,
  REVISION_MAX,
  SOLUTION_LIST_STATUSES,
  TITLE_MAX,
  type VersionState,
} from '../pref';

// Модуль hdk, слой api: редактор решения, версии, список (план M5, задача 3; UX-W-01..05, 10). Права: читают все
// сотрудники, пишут agent_l1, agent_l2, care, admin (решение 10); product видит редактор только для чтения. База
// проверяет то же политиками. Документ проходит закрытую схему до записи (ТЗ 18.10).

export type { ListRow as SolutionListRow } from '../core/editor';
export type { Review as SolutionReview } from '../core/publish';

function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const parsed = schema.safeParse(input);
  if (!parsed.success) throw new HdkError('invalid_input');
  return parsed.data;
}

/** Код ошибки PostgreSQL: withActor бросает ошибку драйвера с полем code. */
const pgCode = (error: unknown): string | undefined => (error && typeof error === 'object' && 'code' in error ? String((error as { code: unknown }).code) : undefined);

export const canWriteSolutions = (ctx: StaffContext): boolean => (KB_WRITER_ROLES as readonly string[]).includes(ctx.actor.staffRole);
export const canPublishSolutions = (ctx: StaffContext): boolean => (KB_PUBLISHER_ROLES as readonly string[]).includes(ctx.actor.staffRole);

function requireWriter(ctx: StaffContext): void {
  if (ctx.actor.type !== 'staff' || !canWriteSolutions(ctx)) throw new HdkError('forbidden');
}

const locale = z.enum(LOCALES);
const number = z.coerce.number().int().positive().max(ARTICLE_NUMBER_MAX);
const revision = z.string().min(1).max(REVISION_MAX);
const listInput = z.strictObject({
  status: z.enum(SOLUTION_LIST_STATUSES).optional(),
  moduleId: z.uuid().optional(),
  locale: locale.optional(),
  mine: z.boolean().optional(),
});
const saveInput = z.strictObject({
  number,
  locale,
  versionId: z.uuid(),
  revision,
  title: z.string().trim().max(TITLE_MAX),
  doc: solutionDocSchema,
});
const restoreInput = z.strictObject({ number, locale, versionId: z.uuid() });
const metaInput = z.strictObject({
  number,
  moduleId: z.uuid().nullable(),
  audience: z.enum(KB_AUDIENCES),
});

/** Список решений с фильтрами; mine: "Мои задачи" сотрудника (UX-W-10). */
export async function listSolutions(ctx: StaffContext, input: unknown): Promise<ListRow[]> {
  const data = parse(listInput, input);
  return withActor(ctx.actor, (tx) =>
    listArticlesTx(tx, {
      ...(data.status ? { status: data.status } : {}),
      ...(data.moduleId ? { moduleId: data.moduleId } : {}),
      ...(data.locale ? { locale: data.locale } : {}),
      ...(data.mine ? { mineOf: ctx.actor.userId } : {}),
    }),
  );
}

export type EditorVersion = {
  versionId: string;
  number: number;
  state: VersionState;
  title: string;
  isMachine: boolean;
  modifiedOn: Date;
};

export type SolutionEditorState = {
  articleId: string;
  number: number;
  moduleId: string | null;
  audience: KbAudience;
  originalLocale: Locale;
  archived: boolean;
  locale: Locale;
  /** Что открывает редактор: черновик, иначе опубликованная версия. */
  current: {
    versionId: string;
    number: number;
    state: VersionState;
    title: string;
    doc: SolutionDoc;
    isMachine: boolean;
    revision: string;
  };
  publishedVersionId: string | null;
  versions: EditorVersion[];
  canWrite: boolean;
  canPublish: boolean;
  /** Находки FR-SOL-04 и панель готовности открытой версии (UX-W-07). */
  review: Review;
};

/** Состояние редактора по номеру решения. Языки переводов появятся в задаче 6: пока язык оригинала. */
export async function solutionEditorState(ctx: StaffContext, input: unknown): Promise<SolutionEditorState | null> {
  const data = parse(z.strictObject({ number, locale: locale.optional() }), input);
  const allowedDomains = await readAllowedDomains();
  return withActor(ctx.actor, async (tx) => {
    const article = await articleByNumberTx(tx, data.number);
    if (!article) return null;
    const lang = data.locale ?? article.originalLocale;
    const versions = await versionsTx(tx, article.articleId, lang);
    const current = currentVersion(versions);
    if (!current) return null;
    const doc = safeParseSolutionDoc(current.doc);
    // Документ в базе прошёл схему при записи; если схема с тех пор сузилась, редактор открывает пустой документ.
    const safeDoc: SolutionDoc = doc.success ? doc.data : { version: 1, blocks: [] };
    return {
      articleId: article.articleId,
      number: article.number,
      moduleId: article.moduleId,
      audience: article.audience,
      originalLocale: article.originalLocale,
      archived: article.status === 'archived',
      locale: lang,
      current: {
        versionId: current.versionId,
        number: current.number,
        state: current.state,
        title: current.title,
        doc: safeDoc,
        isMachine: current.isMachine,
        revision: current.revision,
      },
      publishedVersionId: versions.find((v) => v.state === 'published')?.versionId ?? null,
      versions: versions.map((v) => ({
        versionId: v.versionId,
        number: v.number,
        state: v.state,
        title: v.title,
        isMachine: v.isMachine,
        modifiedOn: v.modifiedOn,
      })),
      canWrite: canWriteSolutions(ctx),
      canPublish: canPublishSolutions(ctx),
      review: await reviewTx(tx, article, { title: current.title, doc: safeDoc, isMachine: current.isMachine }, allowedDomains),
    };
  });
}

export type SaveResult = { status: 'saved'; versionId: string; revision: string; review: Review } | { status: 'conflict' };

/**
 * Автосохранение черновика (UX-W-04) с проверкой версии строки. Изменили в другой вкладке: конфликт, текст на
 * странице не теряется. Изображения документа только из файлов этой статьи.
 */
export async function saveSolutionDraft(ctx: StaffContext, input: unknown): Promise<SaveResult> {
  requireWriter(ctx);
  const data = parse(saveInput, input);
  const allowedDomains = await readAllowedDomains();
  try {
    return await withActor(ctx.actor, async (tx) => {
      const article = await articleByNumberTx(tx, data.number);
      if (!article) throw new HdkError('not_found');
      if ((await foreignFileIdsTx(tx, article.articleId, data.doc)).length > 0) throw new HdkError('invalid_input');
      const saved = await saveDraftTx(tx, {
        articleId: article.articleId,
        locale: data.locale,
        baseVersionId: data.versionId,
        revision: data.revision,
        title: data.title,
        doc: data.doc,
      });
      if (saved === null) throw new HdkError('not_found');
      if (saved === 'conflict') return { status: 'conflict' } as const;
      // Находки и готовность по сохранённому тексту: редактор подсвечивает их после каждого сохранения.
      const isMachine = (await versionByIdTx(tx, article.articleId, data.locale, saved.versionId))?.isMachine ?? false;
      return { status: 'saved', ...saved, review: await reviewTx(tx, article, { title: data.title, doc: data.doc, isMachine }, allowedDomains) } as const;
    });
  } catch (error) {
    // Два первых сохранения после публикации одновременно: второе упирается в единственный черновик на язык.
    if (pgCode(error) === '23505') return { status: 'conflict' };
    throw error;
  }
}

/** Возврат к прежней версии: её текст становится черновиком (UX-W-04). */
export async function restoreSolutionVersion(ctx: StaffContext, input: unknown): Promise<void> {
  requireWriter(ctx);
  const data = parse(restoreInput, input);
  await withActor(ctx.actor, async (tx) => {
    const article = await articleByNumberTx(tx, data.number);
    if (!article) throw new HdkError('not_found');
    if (!(await restoreVersionTx(tx, article, data.locale, data.versionId))) throw new HdkError('not_found');
  });
}

/**
 * Модуль и флаг "только через сотрудника" (аудитория internal, FR-SOL-17). Сузить может любой, кто пишет черновики;
 * открыть опубликованное решение клиентам только публикующий (триггер базы).
 */
export async function saveSolutionMeta(ctx: StaffContext, input: unknown): Promise<void> {
  requireWriter(ctx);
  const data = parse(metaInput, input);
  try {
    await withActor(ctx.actor, async (tx) => {
      const article = await articleByNumberTx(tx, data.number);
      if (!article) throw new HdkError('not_found');
      if (article.status !== 'active') throw new HdkError('forbidden');
      await updateMetaTx(tx, article, {
        moduleId: data.moduleId,
        audience: data.audience,
      });
    });
  } catch (error) {
    if (pgCode(error) === '42501') throw new HdkError('forbidden');
    // Модуль не из справочника.
    if (pgCode(error) === '23503') throw new HdkError('invalid_input');
    throw error;
  }
}
