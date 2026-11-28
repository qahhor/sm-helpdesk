import 'server-only';
import type { ClientActor } from '@/db/with-actor';
import type { Locale } from '@/i18n/locales';
import { clientSolutionPage } from '@/modules/hdk/api/client';
import { clientAnnouncement } from '@/modules/hdp/api/announcements';
import { publicProblemOfTicket } from '@/modules/hdp/api/client';
import type { AiPayload } from '../pref';

// Ответ AI-помощника в проекции виджета (волна 7, T1; FR-AI-08, раздел 8.6 ТЗ; решение 0158). Те же данные и из тех
// же мест, что у сообщения Теза на портале (AiMessage): заголовок и шаги из hdk_published на языке клиента, известная
// проблема из hdp_problems_public, объявление о сбое. Ни одного слова модели: вступление, вопросы и подписи виджет
// рисует по идентификаторам из своих текстов. Идентификатор решения в проекцию не уходит, кроме пары уточняющего
// вопроса: он нужен кнопке выбора.

export type EmbedAiView =
  | {
      kind: 'answer';
      introId: string;
      /** null: решение снято с публикации. doc: документ опубликованной копии, его рисует DocView. */
      solution: { title: string; doc: unknown; locale: string; isMachine: boolean; notTranslated: boolean; updated: boolean; ref: string } | null;
    }
  | { kind: 'clarify'; options: { articleId: string; title: string }[] | null }
  | { kind: 'handoff'; questionIds: string[]; dueOn: string | null; startOn: string | null }
  | { kind: 'ack'; dueOn: string | null; startOn: string | null }
  | { kind: 'known_problem'; problem: { title: string; status: string; body: string; workaround: { title: string; ref: string } | null } | null }
  | { kind: 'outage'; announcement: { title: string; body: string | null; locale: string } | null };

type Ctx = { actor: ClientActor };

/** Данные одного сообщения помощника для виджета. createdOn: когда помощник ответил (пометка "решение обновлено"). */
export async function embedAiView(ctx: Ctx, input: { payload: AiPayload; ticketNumber: number; createdOn: Date; locale: Locale }): Promise<EmbedAiView> {
  const { payload, locale } = input;
  if (payload.kind === 'answer') {
    const page = await clientSolutionPage(ctx, { ref: String(payload.articleNumber), locale });
    if (!page || page.kind === 'archived') return { kind: 'answer', introId: payload.introId, solution: null };
    const s = page.solution;
    return {
      kind: 'answer',
      introId: payload.introId,
      solution: { title: s.title, doc: s.doc, locale: s.locale, isMachine: s.isMachine, notTranslated: page.notTranslated, updated: s.publishedOn.getTime() > input.createdOn.getTime(), ref: page.canonicalRef },
    };
  }
  if (payload.kind === 'clarify') {
    const pages = await Promise.all(payload.options.map((o) => clientSolutionPage(ctx, { ref: String(o.articleNumber), locale })));
    const titles = pages.map((p) => (p && p.kind === 'solution' ? p.solution.title : null));
    return { kind: 'clarify', options: titles.some((t) => t === null) ? null : payload.options.map((o, i) => ({ articleId: o.articleId, title: titles[i]! })) };
  }
  if (payload.kind === 'known_problem') {
    const problem = await publicProblemOfTicket(ctx, { ticketNumber: input.ticketNumber, locale });
    return {
      kind: 'known_problem',
      problem:
        problem && problem.number === payload.problemNumber
          ? {
              title: problem.publicTitle,
              status: problem.status === 'closed' ? 'fixed' : problem.status,
              body: problem.publicBody,
              workaround: problem.workaround ? { title: problem.workaround.title, ref: `${problem.workaround.number}-${problem.workaround.slug}` } : null,
            }
          : null,
    };
  }
  if (payload.kind === 'outage') {
    const a = await clientAnnouncement(ctx, { announcementId: payload.announcementId, locale });
    return { kind: 'outage', announcement: a && !a.ended ? { title: a.title, body: a.body ?? null, locale: a.locale } : null };
  }
  if (payload.kind === 'ack') return { kind: 'ack', dueOn: payload.dueOn, startOn: payload.startOn };
  return { kind: 'handoff', questionIds: [...payload.questionIds], dueOn: payload.dueOn, startOn: payload.startOn };
}
