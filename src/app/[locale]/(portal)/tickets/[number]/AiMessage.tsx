import { getFormatter, getLocale, getTranslations } from 'next-intl/server';
import type { AiPayload } from '@/modules/hdt/api';
import { clientSolutionPage } from '@/modules/hdk/api/client';
import { clientAnnouncement } from '@/modules/hdp/api/announcements';
import { publicProblemOfTicket } from '@/modules/hdp/api/client';
import { isLocale } from '@/i18n/locales';
import type { ClientContext } from '@/modules/hdu/api';
import { Link } from '@/i18n/navigation';
import { TezMark } from '@/ui/brand/TezMark';
import { Button } from '@/ui/components/button';
import { DocView } from '@/ui/doc/DocView';
import { aiFeedbackAction } from './actions';

// Сообщение AI-помощника в обращении клиента (ТЗ 8.6, FR-AI-08, FR-TK-18, UX-B-01..05, UX-C-15; план M5b, задача 5,
// решения 9, 10). Рисуется только для сообщения с типом автора ai и вне текста сообщения: подпись, знак Теза и кнопки
// не может получить текст клиента. Ни одного слова модели: вступление и вопросы по идентификаторам из messages/*.json,
// уточняющий вопрос собирается из заголовков решений, заголовок и шаги берутся из hdk_published на языке клиента
// (FR-SOL-10). Решение снято с публикации: "Решение больше не действует". Решение обновлено после ответа: пометка.
// Известная проблема и сбой (веха M5c, решения 22, 23): публичное название, статус и обходной путь из
// hdp_problems_public, заголовок и текст объявления на языке клиента в момент показа. Скрытая проблема и
// закончившийся сбой: короткая строка без текста.

type Props = {
  client: Pick<ClientContext, 'actor'>;
  number: number;
  messageId: string;
  payload: AiPayload;
  createdOn: Date;
  /** Кнопки только у последнего сообщения помощника, пока помощник ведёт обращение и ждёт реакции клиента. */
  actionable: boolean;
  /** "Помогло" решает обращение: кнопка только у автора и администратора клиента (решение 0096). */
  canResolve: boolean;
  timeZone: string;
};

async function solutionOf(client: Props['client'], articleNumber: number, locale: string) {
  return clientSolutionPage(client, { ref: String(articleNumber), locale });
}

function Buttons({
  number,
  messageId,
  labels,
  extra,
  canResolve = true,
}: {
  number: number;
  messageId: string;
  labels: { label: string; helped: string; notHelped: string; needStaff: string };
  extra?: { choice: string; label: string; articleId?: string }[];
  canResolve?: boolean;
}) {
  const choices = extra ?? [...(canResolve ? [{ choice: 'helped', label: labels.helped }] : []), { choice: 'not_helped', label: labels.notHelped }];
  return (
    <div role="group" aria-label={labels.label} className="flex flex-wrap gap-2" data-testid="tez-actions">
      {[...choices, { choice: 'need_staff', label: labels.needStaff }].map((c) => (
        <form key={`${c.choice}-${'articleId' in c ? c.articleId : ''}`} action={aiFeedbackAction}>
          <input type="hidden" name="number" value={number} />
          <input type="hidden" name="messageId" value={messageId} />
          <input type="hidden" name="choice" value={c.choice} />
          {'articleId' in c && c.articleId && <input type="hidden" name="articleId" value={c.articleId} />}
          <Button type="submit" variant={c.choice === 'helped' ? 'primary' : 'secondary'}>
            {c.label}
          </Button>
        </form>
      ))}
    </div>
  );
}

export async function AiMessage({ client, number, messageId, payload, createdOn, actionable, canResolve, timeZone }: Props) {
  const t = await getTranslations('client.tez');
  const s = await getTranslations('client.solution');
  const locale = await getLocale();
  const format = await getFormatter();
  const when = format.dateTime(createdOn, { dateStyle: 'medium', timeStyle: 'short' });
  const buttons = { label: t('actions.label'), helped: t('actions.helped'), notHelped: t('actions.notHelped'), needStaff: t('actions.needStaff') };
  const dueText = (p: { dueOn: string | null; startOn: string | null }, prefix: 'handoff' | 'ack') => {
    if (p.startOn) {
      const at = new Date(p.startOn);
      return t(`${prefix}.dueStart`, { day: format.dateTime(at, { timeZone, weekday: 'long' }), time: format.dateTime(at, { timeZone, hour: '2-digit', minute: '2-digit' }) });
    }
    return p.dueOn ? t(`${prefix}.due`, { when: format.dateTime(new Date(p.dueOn), { timeZone, day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' }) }) : null;
  };

  // Подтверждение без помощника (FR-AI-15): без знака Теза и подписи.
  if (payload.kind === 'ack')
    return (
      <article className="flex flex-col gap-1" data-message-kind="ack">
        <p className="text-sm text-muted-foreground">{when}</p>
        <p>{t('ack.title')}</p>
        {dueText(payload, 'ack') && <p>{dueText(payload, 'ack')}</p>}
      </article>
    );

  let body: React.ReactNode = null;
  let actions: React.ReactNode = null;
  if (payload.kind === 'answer') {
    const page = await solutionOf(client, payload.articleNumber, locale);
    if (!page || page.kind === 'archived') {
      body = <p data-testid="tez-withdrawn">{t('withdrawn')}</p>;
      if (actionable) actions = <Buttons number={number} messageId={messageId} labels={buttons} extra={[]} />;
    } else {
      const { solution } = page;
      body = (
        <>
          <p>{t(`intro.${payload.introId}`)}</p>
          {solution.publishedOn.getTime() > createdOn.getTime() && <p className="text-sm text-muted-foreground">{t('updated')}</p>}
          {page.notTranslated && <p className="text-sm text-muted-foreground">{t('notTranslated')}</p>}
          {solution.isMachine && <p className="text-sm text-muted-foreground">{t('machine')}</p>}
          <h3 className="font-semibold break-words" lang={solution.locale}>
            {solution.title}
          </h3>
          <div lang={solution.locale} data-testid="tez-steps">
            <DocView doc={solution.doc} labels={{ warning: s('view.warning'), info: s('view.info'), step: (n) => s('view.step', { n }) }} imageSrc={() => null} />
          </div>
          <Link href={`/help/a/${page.canonicalRef}`} className="self-start text-link underline underline-offset-2">
            {t('openFull')}
          </Link>
        </>
      );
      if (actionable) actions = <Buttons number={number} messageId={messageId} labels={buttons} canResolve={canResolve} />;
    }
  } else if (payload.kind === 'clarify') {
    const pages = await Promise.all(payload.options.map((o) => solutionOf(client, o.articleNumber, locale)));
    const titles = pages.map((p) => (p && p.kind === 'solution' ? p.solution.title : null));
    if (titles.some((x) => x === null)) body = <p data-testid="tez-withdrawn">{t('withdrawn')}</p>;
    else {
      body = <p>{t('clarify', { a: titles[0]!, b: titles[1]! })}</p>;
      if (actionable)
        actions = (
          <Buttons
            number={number}
            messageId={messageId}
            labels={buttons}
            extra={payload.options.map((o, i) => ({ choice: 'pick', articleId: o.articleId, label: t('pick', { title: titles[i]! }) }))}
          />
        );
    }
    if (actionable && !actions) actions = <Buttons number={number} messageId={messageId} labels={buttons} extra={[]} />;
  } else if (payload.kind === 'known_problem') {
    const problems = await getTranslations('client.problems');
    const problem = await publicProblemOfTicket(client, { ticketNumber: number, locale: isLocale(locale) ? locale : 'ru' });
    body =
      problem && problem.number === payload.problemNumber ? (
        <>
          <p>{t('knownProblem.title')}</p>
          <h3 className="font-semibold break-words">{problem.publicTitle}</h3>
          <p data-testid="tez-problem-status">{t('knownProblem.status', { status: problems(`statuses.${problem.status === 'closed' ? 'fixed' : problem.status}`) })}</p>
          <p className="whitespace-pre-line break-words">{problem.publicBody}</p>
          {problem.workaround && (
            <p>
              {t('knownProblem.workaround')}{' '}
              <Link href={`/help/a/${problem.workaround.number}-${problem.workaround.slug}`} className="text-link underline underline-offset-2">
                {problem.workaround.title}
              </Link>
            </p>
          )}
          <p>{t('knownProblem.after')}</p>
        </>
      ) : (
        <p>{t('knownProblem.gone')}</p>
      );
  } else if (payload.kind === 'outage') {
    const announcement = await clientAnnouncement(client, { announcementId: payload.announcementId, locale: isLocale(locale) ? locale : 'ru' });
    body =
      announcement && !announcement.ended ? (
        <>
          <p>{t('outage.title')}</p>
          <h3 className="font-semibold break-words" lang={announcement.locale}>
            {announcement.title}
          </h3>
          {announcement.body && (
            <p className="whitespace-pre-line break-words" lang={announcement.locale}>
              {announcement.body}
            </p>
          )}
          <p>{t('outage.after')}</p>
        </>
      ) : (
        <p>{t('outage.gone')}</p>
      );
  } else {
    const due = dueText(payload, 'handoff');
    body = (
      <>
        <p>{t('handoff.title')}</p>
        {due && <p data-testid="tez-due">{due}</p>}
        {payload.questionIds.length > 0 && (
          <>
            <p>{t('handoff.questions')}</p>
            <ul className="list-disc ps-5">
              {payload.questionIds.map((q) => (
                <li key={q}>{t(`questions.${q}`)}</li>
              ))}
            </ul>
          </>
        )}
      </>
    );
  }

  return (
    <article className="flex flex-col gap-2" data-message-kind={payload.kind} data-testid="tez-message">
      <p className="flex items-center gap-2 text-sm text-muted-foreground">
        <TezMark size={32} />
        <span>
          <span className="font-semibold text-foreground">{t('signature')}</span>, {when}
        </span>
      </p>
      <div className="flex flex-col gap-2 rounded-card bg-card-soft p-4">{body}</div>
      {(payload.kind === 'answer' || payload.kind === 'clarify') && <p className="text-sm text-muted-foreground">{t('caption')}</p>}
      {actions}
    </article>
  );
}
