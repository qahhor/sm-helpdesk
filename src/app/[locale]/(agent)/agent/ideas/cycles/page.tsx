import { getFormatter, getTranslations } from 'next-intl/server';
import { Link } from '@/i18n/navigation';
import { cycleCountdown, cycleMonth, EXPLANATION_MAX, ideaRef } from '@/modules/hdi/api/constants';
import { type StaffCycle, staffCycleBoard } from '@/modules/hdi/api/cycles';
import { requireStaffActor } from '@/modules/hdu/api';
import { firstParam } from '@/lib/search-params';
import { Alert } from '@/ui/components/alert';
import { Card, CardContent, CardHeader } from '@/ui/components/card';
import { EmptyState } from '@/ui/components/EmptyState';
import { PageHeader } from '@/ui/components/PageHeader';
import { StatusLabel } from '@/ui/components/StatusLabel';
import { IDEA_STATUS_TONE } from '../../../../idea-status';
import { DecisionForm } from './DecisionForm';

// Отбор месяца на рабочем месте (ТЗ FR-IDEA-09, 10; план M7, задача 9, решения 16, 17): текущая пятёрка со снимком
// и живыми счётчиками, выбор с объяснением на трёх языках (машинный черновик только для сотрудника) и архив отборов.
// Выбирают product и admin, остальные сотрудники видят то же без формы. Заголовки идей выводятся текстом.

const ERRORS = ['forbidden', 'invalid_input', 'not_found', 'cycle_closed', 'not_in_shortlist', 'explanation_required', 'bad_transition'];

export default async function AgentIdeaCyclesPage({ searchParams }: { searchParams: Promise<{ status?: string }> }) {
  const staff = await requireStaffActor();
  const t = await getTranslations('agent');
  const s = await getTranslations('agent.ideas');
  const ci = await getTranslations('client.ideas');
  const format = await getFormatter();
  const status = firstParam((await searchParams).status) ?? '';
  const code = status.startsWith('error-') ? status.slice(6) : null;
  const board = await staffCycleBoard(staff);
  const monthName = (cycle: string) => format.dateTime(cycleMonth(cycle), { month: 'long', year: 'numeric', timeZone: 'UTC' });
  const countdown = cycleCountdown(new Date());
  const current = board.current;

  const shortlistTable = (cycle: StaffCycle) => (
    <div className="overflow-x-auto">
      <table className="w-full text-sm" data-testid="cycle-shortlist">
        <thead>
          <tr className="border-b border-border text-muted-foreground">
            <th scope="col" className="px-3 py-2 text-start font-medium">
              {s('cycles.place')}
            </th>
            <th scope="col" className="px-3 py-2 text-start font-medium">
              {s('columns.title')}
            </th>
            <th scope="col" className="px-3 py-2 text-start font-medium">
              {s('cycles.snapshot')}
            </th>
            <th scope="col" className="px-3 py-2 text-start font-medium">
              {s('cycles.live')}
            </th>
            <th scope="col" className="px-3 py-2 text-start font-medium">
              {s('columns.status')}
            </th>
          </tr>
        </thead>
        <tbody>
          {cycle.shortlist.map((item) => (
            <tr key={item.number} className="border-b border-border last:border-b-0">
              <td className="px-3 py-2 tabular-nums">{item.place}</td>
              <th scope="row" className="px-3 py-2 text-start font-normal">
                <Link href={`/agent/ideas/${item.number}`} className="break-words text-link underline underline-offset-2">
                  {ideaRef(item.number)} {item.title}
                </Link>
              </th>
              <td className="px-3 py-2 tabular-nums">{s('votesCell', { votes: item.snapshot.voteCount, orgs: item.snapshot.orgCount })}</td>
              <td className="px-3 py-2 tabular-nums">{item.live ? s('votesCell', { votes: item.live.voteCount, orgs: item.live.orgCount }) : ''}</td>
              <td className="px-3 py-2">{item.live && <StatusLabel tone={IDEA_STATUS_TONE[item.live.status]}>{ci(`statuses.${item.live.status}`)}</StatusLabel>}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );

  return (
    <>
      <PageHeader
        title={s('cycles.title')}
        breadcrumbs={[{ label: t('home.title'), href: '/agent' }, { label: s('title'), href: '/agent/ideas' }, { label: s('cycles.title') }]}
        breadcrumbsLabel={t('breadcrumbs')}
      />
      <div className="flex flex-col gap-4" data-testid="agent-cycles">
        {code && <Alert tone="danger">{s(`errors.${ERRORS.includes(code) ? code : 'forbidden'}`)}</Alert>}
        {status === 'decided' && <Alert tone="success">{s('done.decided')}</Alert>}
        <p className="text-sm text-secondary-foreground">
          {s('cycles.next', { date: format.dateTime(countdown.endsOn, { dateStyle: 'long', timeStyle: 'short', timeZone: 'Asia/Tashkent' }), month: format.dateTime(countdown.month, { month: 'long', timeZone: 'UTC' }) })}
        </p>
        <Card>
          <CardHeader>
            <h2 className="text-lg font-semibold">{current ? s('cycles.current', { month: monthName(current.cycle) }) : s('cycles.noCurrent')}</h2>
            {current && <p className="text-sm text-secondary-foreground">{s(`cycles.mode.${current.voteMode}`)}</p>}
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            {current ? (
              <>
                {shortlistTable(current)}
                {board.canDecide && (
                  <DecisionForm
                    cycle={current.cycle}
                    max={EXPLANATION_MAX}
                    options={current.shortlist.map((item) => ({ number: item.number, label: `${ideaRef(item.number)} ${item.title}`, leader: item.number === current.leader }))}
                    labels={{
                      legend: s('cycles.pick'),
                      leader: s('cycles.leader'),
                      ru: s('cycles.explanationRu'),
                      uz: s('cycles.explanationUz'),
                      en: s('cycles.explanationEn'),
                      explanationHint: s('cycles.explanationHint'),
                      translate: s('cycles.translate'),
                      translating: s('cycles.translating'),
                      machine: s('cycles.machine'),
                      draftError: s('cycles.draftError'),
                      submit: s('cycles.submit'),
                    }}
                  />
                )}
              </>
            ) : (
              <EmptyState title={s('cycles.noCurrent')} text={s('cycles.noCurrentText')} />
            )}
          </CardContent>
        </Card>
        <section aria-labelledby="cycles-archive" className="flex flex-col gap-3">
          <h2 id="cycles-archive" className="text-lg font-semibold">
            {s('cycles.archive')}
          </h2>
          {board.archive.length === 0 ? (
            <p className="text-sm text-secondary-foreground">{s('cycles.archiveEmpty')}</p>
          ) : (
            <ul className="flex flex-col gap-3" data-testid="agent-cycles-archive">
              {board.archive.map((cycle) => (
                <li key={cycle.cycle}>
                  <Card>
                    <CardContent className="flex flex-col gap-2 pt-4">
                      <p className="font-semibold">
                        {s('cycles.cycleOf', { month: monthName(cycle.cycle) })}{' '}
                        <StatusLabel tone={cycle.status === 'decided' ? 'green' : 'gray'}>{s(`cycles.statuses.${cycle.status}`)}</StatusLabel>
                      </p>
                      {cycle.selected !== null && (
                        <p>
                          {s('cycles.selected')}{' '}
                          <Link href={`/agent/ideas/${cycle.selected}`} className="text-link underline underline-offset-2">
                            {ideaRef(cycle.selected)}
                          </Link>
                          {cycle.selected !== cycle.leader && cycle.leader !== null ? ` (${s('cycles.notLeader', { ref: ideaRef(cycle.leader) })})` : ''}
                        </p>
                      )}
                      {cycle.explanation.ru && <p className="whitespace-pre-wrap break-words text-sm">{cycle.explanation.ru}</p>}
                      {cycle.shortlist.length > 0 && shortlistTable(cycle)}
                    </CardContent>
                  </Card>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </>
  );
}
