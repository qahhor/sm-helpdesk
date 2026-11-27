import { notFound } from 'next/navigation';
import { getFormatter, getTranslations } from 'next-intl/server';
import { Link } from '@/i18n/navigation';
import { firstParam } from '@/lib/search-params';
import { candidateCard } from '@/modules/hda/api/candidate-actions';
import { CANDIDATE_REJECT_REASONS } from '@/modules/hda/api/constants';
import { requireStaffActor } from '@/modules/hdu/api';
import { Alert } from '@/ui/components/alert';
import { Button } from '@/ui/components/button';
import { Card, CardContent } from '@/ui/components/card';
import { Input } from '@/ui/components/input';
import { Label } from '@/ui/components/label';
import { PageHeader } from '@/ui/components/PageHeader';
import { Select } from '@/ui/components/select';
import { StatusLabel } from '@/ui/components/StatusLabel';
import { Textarea } from '@/ui/components/textarea';
import { candidateToDraftAction, mergeCandidateAction, rejectCandidateAction } from '../actions';

// Карточка кандидата (ТЗ 8.12, FR-CAND-04, 09; план M5c, задача 10, решение 29): черновик AI с подсветкой находок
// (телефоны, почта и другие), обращения-источники только сотрудникам, похожее опубликованное решение по вектору и
// три действия: сделать черновиком решения, объединить с решением, отклонить с причиной. Текст модели показывается
// текстом: ни ссылок, ни разметки он получить не может.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ERRORS = new Set(['forbidden', 'invalid_input', 'not_found']);
const DONE = new Set(['merged', 'rejected']);
const label = 'text-xs font-medium text-secondary-foreground';

/** Текст с подсвеченными находками: каждая находка отдельным элементом mark. */
function Highlighted({ text, marks }: { text: string; marks: readonly string[] }) {
  const found = marks.filter((m) => m && text.includes(m));
  if (found.length === 0) return <>{text}</>;
  const pattern = new RegExp(`(${found.map((m) => m.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`, 'g');
  return (
    <>
      {text.split(pattern).map((part, i) =>
        found.includes(part) ? (
          <mark key={i} className="rounded-control bg-warning-bg px-0.5" data-finding>
            {part}
          </mark>
        ) : (
          <span key={i}>{part}</span>
        ),
      )}
    </>
  );
}

export default async function AgentCandidatePage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ done?: string; error?: string }> }) {
  const staff = await requireStaffActor({ roles: ['agent_l1', 'agent_l2', 'care', 'admin'] });
  const { id } = await params;
  if (!UUID.test(id)) notFound();
  const card = await candidateCard(staff, { id });
  if (!card) notFound();
  const t = await getTranslations('agent');
  const s = await getTranslations('agent.candidates');
  const format = await getFormatter();
  const search = await searchParams;
  const done = firstParam(search.done);
  const error = firstParam(search.error);
  const marks = card.findings.map((f) => f.text);
  const open = card.status === 'new' || card.status === 'rejected';
  const hidden = <input type="hidden" name="id" value={card.candidateId} />;
  return (
    <>
      <PageHeader
        title={card.title}
        breadcrumbs={[{ label: t('home.title'), href: '/agent' }, { label: s('title'), href: '/agent/candidates' }, { label: s('card') }]}
        breadcrumbsLabel={t('breadcrumbs')}
      />
      <div className="grid gap-4 lg:grid-cols-3" data-testid="agent-candidate">
        <div className="flex min-w-0 flex-col gap-4 lg:col-span-2">
          {done && DONE.has(done) && <Alert tone="success">{s(`done.${done}`)}</Alert>}
          {error && <Alert tone="danger">{s(`errors.${ERRORS.has(error) ? error : 'forbidden'}`)}</Alert>}
          <Card>
            <CardContent className="flex flex-col gap-3 pt-6">
              <p className="flex flex-wrap items-center gap-2 text-sm">
                <StatusLabel tone={card.status === 'new' ? 'blue' : card.status === 'rejected' ? 'orange' : 'green'}>{s(`statuses.${card.status}`)}</StatusLabel>
                <span className="text-secondary-foreground">{s('aiDraft')}</span>
              </p>
              <h2 className="text-lg font-semibold break-words" lang={card.locale}>
                <Highlighted text={card.title} marks={marks} />
              </h2>
              <p className="whitespace-pre-line break-words" lang={card.locale}>
                <Highlighted text={card.problem} marks={marks} />
              </p>
              <ol className="list-decimal ps-5" lang={card.locale} data-testid="candidate-steps">
                {card.steps.map((step, i) => (
                  <li key={i} className="break-words">
                    <Highlighted text={step} marks={marks} />
                  </li>
                ))}
              </ol>
              {card.findings.length > 0 && (
                <section aria-labelledby="candidate-findings" className="flex flex-col gap-1">
                  <h3 id="candidate-findings" className="font-semibold">
                    {s('findings')}
                  </h3>
                  <ul className="flex flex-col gap-1 text-sm" data-testid="candidate-findings">
                    {card.findings.map((f, i) => (
                      <li key={i}>
                        {s(`kinds.${f.kind}`)}: <code className="break-all rounded-control bg-card-soft px-1">{f.text}</code>
                      </li>
                    ))}
                  </ul>
                </section>
              )}
            </CardContent>
          </Card>
          {open && (
            <Card>
              <CardContent className="flex flex-col gap-4 pt-6">
                <form action={candidateToDraftAction} className="flex flex-col gap-2">
                  {hidden}
                  <p className="text-sm text-secondary-foreground">{s('toDraftHint')}</p>
                  <Button type="submit" className="self-start">
                    {s('toDraft')}
                  </Button>
                </form>
                <form action={mergeCandidateAction} className="flex flex-wrap items-end gap-2">
                  {hidden}
                  <div className="flex flex-col gap-1">
                    <Label htmlFor="candidate-article">{s('mergeNumber')}</Label>
                    <Input id="candidate-article" name="articleNumber" type="number" min={1} required />
                  </div>
                  <Button type="submit" variant="secondary">
                    {s('merge')}
                  </Button>
                </form>
                <form action={rejectCandidateAction} className="flex flex-col gap-2">
                  {hidden}
                  <div className="flex flex-col gap-1">
                    <Label htmlFor="candidate-reason">{s('rejectReason')}</Label>
                    <Select id="candidate-reason" name="reason" required defaultValue="">
                      <option value="" disabled>
                        {s('chooseReason')}
                      </option>
                      {CANDIDATE_REJECT_REASONS.map((reason) => (
                        <option key={reason} value={reason}>
                          {s(`reasons.${reason}`)}
                        </option>
                      ))}
                    </Select>
                  </div>
                  <div className="flex flex-col gap-1">
                    <Label htmlFor="candidate-comment">{s('rejectComment')}</Label>
                    <Textarea id="candidate-comment" name="comment" maxLength={1000} rows={2} />
                  </div>
                  <Button type="submit" variant="ghost" className="self-start">
                    {s('reject')}
                  </Button>
                </form>
              </CardContent>
            </Card>
          )}
        </div>
        {/* min-w-0 у обеих колонок: иначе на узкой ширине колонка сетки берёт ширину содержимого правой колонки (решение 0126). */}
        <aside className="flex min-w-0 flex-col gap-4" aria-label={s('info')}>
          <Card>
            <CardContent className="flex flex-col gap-2 pt-6 text-sm">
              <h2 className={label}>{s('info')}</h2>
              <p>{s('counts', { sources: card.sourceCount, orgs: card.orgCount })}</p>
              <p>{s('createdOn', { date: format.dateTime(card.createdOn, { dateStyle: 'medium' }) })}</p>
              <h3 className={label}>{s('sources')}</h3>
              <ul className="flex flex-wrap gap-x-2" data-testid="candidate-sources">
                {card.sourceTickets.map((number) => (
                  <li key={number}>
                    <Link href={`/agent/tickets/SUP-${number}`} className="text-link underline underline-offset-2">
                      SUP-{number}
                    </Link>
                  </li>
                ))}
              </ul>
              <h3 className={label}>{s('similar')}</h3>
              <p>{card.similar ? s('similarValue', { percent: Math.round(card.similar.similarity * 100) }) : s('noSimilar')}</p>
            </CardContent>
          </Card>
        </aside>
      </div>
    </>
  );
}
