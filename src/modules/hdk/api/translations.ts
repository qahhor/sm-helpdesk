import 'server-only';
import * as z from 'zod';
import { withActor } from '@/db/with-actor';
import { LOCALES } from '@/i18n/locales';
import { enqueue, type StaffContext } from '@/modules/hdc/api';
import { articleByNumberTx } from '../core/editor';
import { requestMachineTranslationTx, startManualTranslationTx, type StartResult } from '../core/translations';
import { HdkError } from '../error';
import { ARTICLE_NUMBER_MAX, KB_WRITER_ROLES } from '../pref';

// Модуль hdk, слой api: начало перевода решения (план M5, задача 6; UX-W-06, FR-SOL-06, решения 3 и 9). Переводят роли
// черновиков. "Перевести с AI" только ставит задачу kb.translate после фиксации: модель вызывает фоновый процесс,
// страница показывает "готовится" и обновляется сама.

const input = z.strictObject({ number: z.coerce.number().int().positive().max(ARTICLE_NUMBER_MAX), locale: z.enum(LOCALES) });

function requireWriter(ctx: StaffContext): void {
  if (ctx.actor.type !== 'staff' || !(KB_WRITER_ROLES as readonly string[]).includes(ctx.actor.staffRole)) throw new HdkError('forbidden');
}

function parse(value: unknown) {
  const parsed = input.safeParse(value);
  if (!parsed.success) throw new HdkError('invalid_input');
  return parsed.data;
}

export type TranslationStart = Exclude<StartResult, 'original_locale'>;

/** Черновик перевода копией опубликованного оригинала: сотрудник переводит сам. */
export async function startManualTranslation(ctx: StaffContext, value: unknown): Promise<TranslationStart> {
  requireWriter(ctx);
  const data = parse(value);
  const result = await withActor(ctx.actor, async (tx) => {
    const article = await articleByNumberTx(tx, data.number);
    if (!article || article.status !== 'active') throw new HdkError('not_found');
    return startManualTranslationTx(tx, article, data.locale);
  });
  if (result === 'original_locale') throw new HdkError('invalid_input');
  return result;
}

/** Машинный перевод: отметка "готовится" и задача фоновому процессу. Без опубликованного оригинала: no_original. */
export async function requestMachineTranslation(ctx: StaffContext, value: unknown): Promise<TranslationStart> {
  requireWriter(ctx);
  const data = parse(value);
  const result = await withActor(ctx.actor, async (tx) => {
    const article = await articleByNumberTx(tx, data.number);
    if (!article || article.status !== 'active') throw new HdkError('not_found');
    return { start: await requestMachineTranslationTx(tx, article, data.locale), articleId: article.articleId };
  });
  if (result.start === 'original_locale') throw new HdkError('invalid_input');
  if (result.start === 'started') await enqueue('kb.translate', { articleId: result.articleId, locale: data.locale });
  return result.start;
}
