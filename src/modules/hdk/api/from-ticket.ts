import 'server-only';
import * as z from 'zod';
import { withActor } from '@/db/with-actor';
import { isLocale, type Locale } from '@/i18n/locales';
import { enqueue, type StaffContext, writeAudit } from '@/modules/hdc/api';
import { ticketSolutionSource } from '@/modules/hdt/api/solution-source';
import { orgAiProfile } from '@/modules/hdu/api/orgs';
import { createDraftTx } from '../core/articles';
import { articleByNumberTx } from '../core/editor';
import { articleOfTicketTx, insertSourceTx, sourceTicketIdsTx } from '../core/from-ticket';
import { bindSignatureTx } from '../core/signatures';
import { setAiStatusTx } from '../core/translations';
import { HdkError } from '../error';
import { ARTICLE_NUMBER_MAX, KB_WRITER_ROLES, TITLE_MAX } from '../pref';
import { solutionTemplate, type TemplateLabels } from '../template';

// Модуль hdk, слой api: решение из закрытого обращения (ТЗ FR-SOL-02, 03, UX-W-09, сценарий S5; план M5, задача 7,
// решения 3 и 15). "Опубликовать как решение" в окне закрытия и кнопка "Создать решение" на странице решённого
// обращения создают статью сразу: язык обращения, его модуль, тема заголовком и пустые три блока формы, источник в
// hdk_article_sources (виден только сотрудникам). Если у организации включена AI-обработка, ставится задача kb.draft:
// фоновый процесс заполнит черновик текстом модели с пометкой "AI, не проверено". Без AI-обработки или без ключа
// сотрудник пишет сам по заготовке. Публикация только сотрудником с правом публикации и после "Текст прочитан".
//
// Сигнатура ошибки обращения (задача 8) привязывается к новому решению в той же транзакции, если она ещё ни к
// какому решению не привязана: следующий клиент с той же ошибкой увидит решение точным совпадением (S5, шаг 5).

const input = z.strictObject({ number: z.coerce.number().int().positive().max(ARTICLE_NUMBER_MAX) });

export type FromTicketResult = { number: number; created: boolean };

/**
 * Решение из обращения по его номеру. Обращение решено или закрыто; решение из него уже есть: возвращается оно.
 * labelsFor: подписи трёх блоков формы на языке решения (из messages/*.json страницы).
 */
export async function createSolutionFromTicket(ctx: StaffContext, value: unknown, labelsFor: (locale: Locale) => TemplateLabels, newId: () => string): Promise<FromTicketResult> {
  if (ctx.actor.type !== 'staff' || !(KB_WRITER_ROLES as readonly string[]).includes(ctx.actor.staffRole)) throw new HdkError('forbidden');
  const parsed = input.safeParse(value);
  if (!parsed.success) throw new HdkError('invalid_input');
  const ticket = await ticketSolutionSource(ctx.actor, { number: parsed.data.number });
  if (!ticket) throw new HdkError('not_found');
  if (ticket.status !== 'resolved' && ticket.status !== 'closed') throw new HdkError('not_resolved');
  const profile = await orgAiProfile(ctx.actor, { orgId: ticket.orgId, userIds: [] });
  const aiAllowed = profile?.isAiEnabled === true;
  const locale: Locale = isLocale(ticket.locale) ? ticket.locale : 'ru';
  const result = await withActor(ctx.actor, async (tx) => {
    const existing = await articleOfTicketTx(tx, ticket.ticketId);
    if (existing !== null) return { number: existing, created: false, articleId: null };
    const article = await createDraftTx(tx, {
      locale,
      title: ticket.title.trim().slice(0, TITLE_MAX),
      audience: 'clients',
      moduleId: ticket.moduleId,
      ownerId: ctx.actor.userId,
      doc: solutionTemplate(labelsFor(locale), newId),
    });
    await insertSourceTx(tx, { orgId: ticket.orgId, articleId: article.articleId, ticketId: ticket.ticketId });
    await setAiStatusTx(tx, article.articleId, locale, aiAllowed ? 'pending' : 'disabled');
    await writeAudit(tx, {
      action: 'solution.created_from_ticket',
      objectType: 'solution',
      objectId: article.articleId,
      orgId: ticket.orgId,
      diff: { number: article.number, ticket: ticket.number, ai: aiAllowed },
    });
    if (ticket.errorSignature) {
      // Строка сигнатуры есть с момента создания обращения; пример уже очищен там. Занятая сигнатура остаётся у
      // своего решения.
      const bound = await bindSignatureTx(tx, article.articleId, { signature: ticket.errorSignature, code: '', sample: '' });
      if (bound.status === 'bound' && bound.changed)
        await writeAudit(tx, { action: 'solution.signature_bound', objectType: 'solution', objectId: article.articleId, diff: { number: article.number, signature: bound.signature } });
    }
    return { number: article.number, created: true, articleId: article.articleId };
  });
  if (result.articleId && aiAllowed) await enqueue('kb.draft', { articleId: result.articleId });
  return { number: result.number, created: result.created };
}

/** Номер решения, выросшего из обращения, для страницы обращения сотрудника. */
export async function solutionOfTicket(ctx: StaffContext, ticketId: unknown): Promise<number | null> {
  const id = z.uuid().safeParse(ticketId);
  if (!id.success) throw new HdkError('invalid_input');
  return withActor(ctx.actor, (tx) => articleOfTicketTx(tx, id.data));
}

export type SourceThread = { number: number; title: string; messages: { role: 'client' | 'staff'; body: string }[] };

/**
 * Публичная переписка исходных обращений для экрана черновика (поправка 101, пункт 8: текст модели рядом с
 * оригиналом). Только сотрудникам; авторы названы ролью, внутренних заметок и вложений нет.
 */
export async function solutionSourceThreads(ctx: StaffContext, value: unknown): Promise<SourceThread[]> {
  const parsed = input.safeParse(value);
  if (!parsed.success) throw new HdkError('invalid_input');
  const ticketIds = await withActor(ctx.actor, async (tx) => {
    const article = await articleByNumberTx(tx, parsed.data.number);
    return article ? sourceTicketIdsTx(tx, article.articleId) : [];
  });
  const threads: SourceThread[] = [];
  for (const ticketId of ticketIds) {
    const ticket = await ticketSolutionSource(ctx.actor, { ticketId });
    if (!ticket) continue;
    threads.push({
      number: ticket.number,
      title: ticket.title,
      messages: [{ role: 'client', body: ticket.description }, ...ticket.messages.map((m) => ({ role: m.authorType, body: m.body }))],
    });
  }
  return threads;
}
