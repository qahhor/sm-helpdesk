import { getFormatter, getTranslations } from 'next-intl/server';
import { Link } from '@/i18n/navigation';
import { AI_REVIEW_RESULTS } from '@/modules/hda/api/constants';
import { type AiReviewRow, aiReviewList } from '@/modules/hda/api/review';
import { requireStaffActor } from '@/modules/hdu/api';
import { Alert } from '@/ui/components/alert';
import { Button } from '@/ui/components/button';
import { Card, CardContent } from '@/ui/components/card';
import { PageHeader } from '@/ui/components/PageHeader';
import { Select } from '@/ui/components/select';
import { reviewAiAnswerAction } from './actions';

// "Разбор ответов AI" (FR-AI-16, экран "Сводки и разбор ответов AI"; план M5b, задача 8). Три списка: ответы,
// отмеченные сотрудниками как неверные, ответы в обращениях с оценкой ниже 4 и последние ответы за две недели для
// просмотра первых недель пилота (15.6). Итог разбора пишут вторая линия, care и администратор.

const REVIEWERS: readonly string[] = ['agent_l2', 'care', 'admin'];
const head = 'px-3 py-2 text-start text-xs font-medium text-secondary-foreground';
const cell = 'px-3 py-2 align-top';

export default async function AiReviewPage({ searchParams }: { searchParams: Promise<{ done?: string; error?: string }> }) {
  const staff = await requireStaffActor();
  const t = await getTranslations('agent');
  const r = await getTranslations('agent.aiReview');
  const format = await getFormatter();
  const params = await searchParams;
  const list = await aiReviewList(staff);
  const canReview = REVIEWERS.includes(staff.actor.staffRole);
  const error = params.error === 'forbidden' || params.error === 'invalid_input' ? params.error : null;

  const section = (key: 'flagged' | 'lowRated' | 'sample', rows: AiReviewRow[]) => (
    <Card key={key} data-testid={`ai-review-${key}`}>
      <CardContent className="flex flex-col gap-3 overflow-x-auto pt-6">
        <h2 className="font-semibold">{r(key)}</h2>
        {rows.length === 0 ? (
          <p className="text-sm text-secondary-foreground">{r('empty')}</p>
        ) : (
          <table className="w-full text-sm">
            <caption className="sr-only">{r(key)}</caption>
            <thead>
              <tr className="border-b border-border">
                <th scope="col" className={head}>{r('columns.ticket')}</th>
                <th scope="col" className={head}>{r('columns.solution')}</th>
                <th scope="col" className={head}>{r('columns.reason')}</th>
                <th scope="col" className={head}>{r('columns.rating')}</th>
                <th scope="col" className={head}>{r('columns.result')}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={`${key}-${row.runId}`} className="border-b border-border last:border-0" data-number={row.number}>
                  <td className={cell}>
                    <Link href={`/agent/tickets/SUP-${row.number}`} className="font-semibold text-link hover:underline">
                      SUP-{row.number}
                    </Link>
                    <span className="block text-xs text-muted-foreground">{format.dateTime(row.createdOn, { dateStyle: 'short', timeStyle: 'short' })}</span>
                  </td>
                  <td className={cell}>
                    {row.solutionNumber ? (
                      <Link href={`/agent/solutions/${row.solutionNumber}`} className="text-link hover:underline">
                        #{row.solutionNumber}
                      </Link>
                    ) : (
                      <span className="text-muted-foreground">{row.solutionId ? '' : r('noSolution')}</span>
                    )}
                  </td>
                  <td className={cell}>
                    {row.flagReason ? t(`ticket.flag.reasons.${row.flagReason}`) : <span className="text-muted-foreground">{r('noReason')}</span>}
                    {row.flagComment && <span className="block break-words text-xs text-secondary-foreground">{row.flagComment}</span>}
                  </td>
                  <td className={cell}>{row.rating ?? ''}</td>
                  <td className={cell}>
                    {canReview ? (
                      <form action={reviewAiAnswerAction} className="flex flex-wrap items-center gap-2">
                        <input type="hidden" name="runId" value={row.runId} />
                        <Select name="result" defaultValue={row.reviewResult ?? 'no_change'} aria-label={r('resultLabel', { ticket: `SUP-${row.number}` })}>
                          {AI_REVIEW_RESULTS.map((value) => (
                            <option key={value} value={value}>
                              {r(`results.${value}`)}
                            </option>
                          ))}
                        </Select>
                        <Button type="submit" variant="secondary" size="small">
                          {r('save')}
                        </Button>
                      </form>
                    ) : (
                      (row.reviewResult ? r(`results.${row.reviewResult}`) : <span className="text-muted-foreground">{r('noResult')}</span>)
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </CardContent>
    </Card>
  );

  return (
    <>
      <PageHeader title={r('title')} breadcrumbs={[{ label: t('home.title'), href: '/agent' }, { label: r('title') }]} breadcrumbsLabel={t('breadcrumbs')} />
      <div className="flex flex-col gap-4">
        <p className="text-secondary-foreground">{r('intro')}</p>
        {params.done === '1' && <Alert tone="success">{r('done')}</Alert>}
        {error && <Alert tone="danger">{r(`errors.${error}`)}</Alert>}
        {section('flagged', list.flagged)}
        {section('lowRated', list.lowRated)}
        {section('sample', list.sample)}
      </div>
    </>
  );
}
