'use client';

import type { SolutionDoc } from '@/modules/hdk/doc-schema';
import { TezMark } from '@/ui/brand/TezMark';
import { Button } from '@/ui/components/button';
import { DocView } from '@/ui/doc/DocView';
import { fill, useWidget } from './session';

// Ответ AI-помощника в виджете (волна 7, T1; раздел 8.6 ТЗ, FR-AI-08, UX-B-01..05; решение 0158). Тот же вид, что у
// сообщения Теза на портале (AiMessage): знак Теза только через TezMark, подпись "Тез · AI-ассистент", строка "Ответ
// подготовлен AI", кнопки "Помогло", "Не помогло", "Нужен сотрудник". Рисуется только для сообщения с автором ai и
// только из данных проекции (GET /api/embed/tickets/{номер}): текст клиента этого вида не получает. Ни одного слова
// модели: вступление и вопросы по идентификаторам из текстов виджета, заголовок и шаги из опубликованного решения.

type Solution = { title: string; doc: unknown; locale: string; isMachine: boolean; notTranslated: boolean; updated: boolean; ref: string };
export type TezAi = { actionable: boolean; canResolve: boolean } & (
  | { kind: 'answer'; introId: string; solution: Solution | null }
  | { kind: 'clarify'; options: { articleId: string; title: string }[] | null }
  | { kind: 'handoff'; questionIds: string[]; dueOn: string | null; startOn: string | null }
  | { kind: 'ack'; dueOn: string | null; startOn: string | null }
  | { kind: 'known_problem'; problem: { title: string; status: string; body: string; workaround: { title: string; ref: string } | null } | null }
  | { kind: 'outage'; announcement: { title: string; body: string | null; locale: string } | null }
);
export type TezFeedback = { messageId: string; choice: 'helped' | 'not_helped' | 'need_staff' | 'pick'; articleId?: string };

export function TezMessage({ messageId, ai, createdOn, timeZone, busy, onFeedback }: { messageId: string; ai: TezAi; createdOn: string; timeZone: string; busy: boolean; onFeedback(feedback: TezFeedback): void }) {
  const w = useWidget();
  const l = w.labels;
  const text = (key: string) => l[`tez.${key}`] ?? '';
  const date = (iso: string, options: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat(w.locale, { timeZone, ...options }).format(new Date(iso));
  const when = date(createdOn, { dateStyle: 'medium', timeStyle: 'short' });
  const due = (p: { dueOn: string | null; startOn: string | null }, prefix: 'handoff' | 'ack') =>
    p.startOn
      ? fill(text(`${prefix}.dueStart`), { day: date(p.startOn, { weekday: 'long' }), time: date(p.startOn, { hour: '2-digit', minute: '2-digit' }) })
      : p.dueOn
        ? fill(text(`${prefix}.due`), { when: date(p.dueOn, { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' }) })
        : null;

  // Подтверждение без помощника (FR-AI-15): без знака Теза и подписи.
  if (ai.kind === 'ack')
    return (
      <div className="flex flex-col gap-1 rounded-card border border-border bg-card p-3" data-author="support" data-message-kind="ack">
        <p className="text-sm text-secondary-foreground">{when}</p>
        <p>{text('ack.title')}</p>
        {due(ai, 'ack') && <p>{due(ai, 'ack')}</p>}
      </div>
    );

  const portalLink = (ref: string, label: string) => (
    <a href={w.nav.portalHref(`/help/a/${ref}`)} target="_blank" rel="noopener noreferrer" className="self-start text-link underline underline-offset-2">
      {label}
    </a>
  );
  let body: React.ReactNode;
  let choices: { choice: TezFeedback['choice']; label: string; articleId?: string }[] = [];
  if (ai.kind === 'answer') {
    if (!ai.solution) body = <p data-testid="tez-withdrawn">{text('withdrawn')}</p>;
    else {
      const s = ai.solution;
      body = (
        <>
          <p>{text(`intro.${ai.introId}`)}</p>
          {s.updated && <p className="text-sm text-secondary-foreground">{text('updated')}</p>}
          {s.notTranslated && <p className="text-sm text-secondary-foreground">{text('notTranslated')}</p>}
          {s.isMachine && <p className="text-sm text-secondary-foreground">{text('machine')}</p>}
          <h3 className="font-semibold break-words" lang={s.locale}>
            {s.title}
          </h3>
          <div lang={s.locale} data-testid="tez-steps">
            <DocView doc={s.doc as SolutionDoc} labels={{ warning: l['view.warning'] ?? '', info: l['view.info'] ?? '', step: (n) => fill(l['view.step'] ?? '', { n }) }} />
          </div>
          {portalLink(s.ref, text('openFull'))}
        </>
      );
      choices = [...(ai.canResolve ? [{ choice: 'helped' as const, label: text('actions.helped') }] : []), { choice: 'not_helped' as const, label: text('actions.notHelped') }];
    }
  } else if (ai.kind === 'clarify') {
    if (!ai.options) body = <p data-testid="tez-withdrawn">{text('withdrawn')}</p>;
    else {
      body = <p>{fill(text('clarify'), { a: ai.options[0]?.title ?? '', b: ai.options[1]?.title ?? '' })}</p>;
      choices = ai.options.map((o) => ({ choice: 'pick' as const, articleId: o.articleId, label: fill(text('pick'), { title: o.title }) }));
    }
  } else if (ai.kind === 'known_problem') {
    body = ai.problem ? (
      <>
        <p>{text('knownProblem.title')}</p>
        <h3 className="font-semibold break-words">{ai.problem.title}</h3>
        <p data-testid="tez-problem-status">{fill(text('knownProblem.status'), { status: l[`problemStatuses.${ai.problem.status}`] ?? ai.problem.status })}</p>
        <p className="whitespace-pre-line break-words">{ai.problem.body}</p>
        {ai.problem.workaround && (
          <p>
            {text('knownProblem.workaround')} {portalLink(ai.problem.workaround.ref, ai.problem.workaround.title)}
          </p>
        )}
        <p>{text('knownProblem.after')}</p>
      </>
    ) : (
      <p>{text('knownProblem.gone')}</p>
    );
  } else if (ai.kind === 'outage') {
    body = ai.announcement ? (
      <>
        <p>{text('outage.title')}</p>
        <h3 className="font-semibold break-words" lang={ai.announcement.locale}>
          {ai.announcement.title}
        </h3>
        {ai.announcement.body && (
          <p className="whitespace-pre-line break-words" lang={ai.announcement.locale}>
            {ai.announcement.body}
          </p>
        )}
        <p>{text('outage.after')}</p>
      </>
    ) : (
      <p>{text('outage.gone')}</p>
    );
  } else {
    const dueText = due(ai, 'handoff');
    body = (
      <>
        <p>{text('handoff.title')}</p>
        {dueText && <p data-testid="tez-due">{dueText}</p>}
        {ai.questionIds.length > 0 && (
          <>
            <p>{text('handoff.questions')}</p>
            <ul className="list-disc ps-5">
              {ai.questionIds.map((q) => (
                <li key={q}>{text(`questions.${q}`)}</li>
              ))}
            </ul>
          </>
        )}
      </>
    );
  }

  return (
    <div className="flex flex-col gap-2" data-author="ai" data-message-kind={ai.kind} data-testid="tez-message">
      <p className="flex items-center gap-2 text-sm text-secondary-foreground">
        <TezMark size={32} />
        <span>
          <span className="font-semibold text-foreground">{text('signature')}</span>, {when}
        </span>
      </p>
      <div className="flex flex-col gap-2 rounded-card bg-card-soft p-3">{body}</div>
      {(ai.kind === 'answer' || ai.kind === 'clarify') && <p className="text-sm text-secondary-foreground">{text('caption')}</p>}
      {ai.actionable && (
        <div role="group" aria-label={text('actions.label')} className="flex flex-wrap gap-2" data-testid="tez-actions">
          {[...choices, { choice: 'need_staff' as const, label: text('actions.needStaff') }].map((c) => (
            <Button
              key={`${c.choice}-${'articleId' in c ? c.articleId : ''}`}
              variant={c.choice === 'helped' ? 'primary' : 'secondary'}
              disabled={busy}
              onClick={() => onFeedback({ messageId, choice: c.choice, ...('articleId' in c && c.articleId ? { articleId: c.articleId } : {}) })}
            >
              {c.label}
            </Button>
          ))}
        </div>
      )}
    </div>
  );
}
