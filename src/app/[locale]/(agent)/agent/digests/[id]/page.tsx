import { notFound } from 'next/navigation';
import { getFormatter, getTranslations } from 'next-intl/server';
import { Link } from '@/i18n/navigation';
import { firstParam } from '@/lib/search-params';
import { digestCard } from '@/modules/hda/api/digests';
import { requireStaffActor } from '@/modules/hdu/api';
import { AgentMark } from '@/ui/components/AgentMark';
import { Alert } from '@/ui/components/alert';
import { Button } from '@/ui/components/button';
import { Card, CardContent } from '@/ui/components/card';
import { PageHeader } from '@/ui/components/PageHeader';
import { StatusLabel } from '@/ui/components/StatusLabel';
import { markReviewedAction } from '../actions';

// Карточка сводки AI-сотрудника (ТЗ 8.12 "Сводки"; FR-AGT-04, 07; план M8b, задача 10, решения 22, 23): текст агента
// обычным текстом (без разметки и активных ссылок), период, числа и номера обращений ссылками портала, кнопка
// "Просмотрено". До отметки сводка с пометкой "AI-сотрудник, не проверено".

export default async function DigestPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ status?: string }> }) {
  const staff = await requireStaffActor();
  const card = await digestCard(staff, (await params).id);
  if (!card) notFound();
  const t = await getTranslations('agent');
  const s = await getTranslations('agent.digests');
  const format = await getFormatter();
  const status = firstParam((await searchParams).status) ?? '';
  const when = (value: Date) => format.dateTime(value, { dateStyle: 'medium', timeStyle: 'short' });
  const numbers = Object.entries(card.numbers).filter(([, value]) => typeof value === 'number');
  return (
    <>
      <PageHeader
        title={card.title}
        breadcrumbs={[{ label: t('home.title'), href: '/agent' }, { label: s('title'), href: '/agent/digests' }, { label: s(`kinds.${card.kind}`) }]}
        breadcrumbsLabel={t('breadcrumbs')}
      />
      <div className="flex flex-col gap-4" data-testid="agent-digest">
        {status === 'reviewed' && <Alert tone="success">{s('done')}</Alert>}
        {status.startsWith('error-') && <Alert tone="danger">{s('error')}</Alert>}
        <div className="flex flex-wrap items-center gap-2 text-sm">
          {card.status === 'reviewed' ? <StatusLabel tone="green">{s('statuses.reviewed')}</StatusLabel> : <AgentMark label={t('aiStaff.mark')} />}
          <span>{s(`kinds.${card.kind}`)}</span>
          <span>{s('createdOn', { time: when(card.createdOn) })}</span>
          {card.periodFrom && card.periodTo && <span>{s('period', { from: when(card.periodFrom), to: when(card.periodTo) })}</span>}
        </div>
        <Card>
          <CardContent className="flex flex-col gap-4 pt-6">
            <p className="whitespace-pre-wrap break-words" data-agent-text="">
              {card.body}
            </p>
            {numbers.length > 0 && (
              <ul className="flex flex-col gap-1 text-sm">
                {numbers.map(([key, value]) => (
                  <li key={key}>{s(`numbers.${key as 'new_tickets'}`, { count: value as number })}</li>
                ))}
              </ul>
            )}
            {card.ticketNumbers.length > 0 && (
              <div className="flex flex-col gap-1 text-sm">
                <p className="font-medium">{s('tickets')}</p>
                <ul className="flex flex-wrap gap-3">
                  {card.ticketNumbers.map((n) => (
                    <li key={n}>
                      <Link href={`/agent/tickets/${n}`} className="text-link underline underline-offset-2">
                        #{n}
                      </Link>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </CardContent>
        </Card>
        {card.status === 'unverified' ? (
          <form action={markReviewedAction}>
            <input type="hidden" name="id" value={card.id} />
            <Button type="submit">{s('review')}</Button>
          </form>
        ) : (
          card.reviewedOn && <p className="text-sm text-secondary-foreground">{s('reviewedOn', { time: when(card.reviewedOn) })}</p>
        )}
      </div>
    </>
  );
}
