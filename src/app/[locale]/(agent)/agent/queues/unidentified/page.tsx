import { getFormatter, getTranslations } from 'next-intl/server';
import { Link } from '@/i18n/navigation';
import { listUnidentified } from '@/modules/hdt/api';
import { requireStaffActor, searchOrganizations } from '@/modules/hdu/api';
import { Alert } from '@/ui/components/alert';
import { Card, CardContent } from '@/ui/components/card';
import { EmptyState } from '@/ui/components/EmptyState';
import { PageHeader } from '@/ui/components/PageHeader';
import { cn } from '@/ui/cn';
import { BindPanel } from './BindPanel';

// "Неопознанные" (FR-EM-04, решения 12-14 вехи M4): письма с адресов, которых портал не узнал. Слева список (номер,
// от кого, тема), справа панель привязки выбранного письма.

type Search = { number?: string; q?: string; page?: string; done?: string; error?: string };

const DONE = ['bound', 'boundNoInvite', 'notClient', 'spam'] as const;
const ERRORS = ['forbidden', 'not_found', 'transition_refused', 'invalid_input'] as const;

export default async function UnidentifiedPage({ searchParams }: { searchParams: Promise<Search> }) {
  const staff = await requireStaffActor();
  const t = await getTranslations('agent');
  const format = await getFormatter();
  const params = await searchParams;
  const page = Math.max(1, Math.min(1000, Number(params.page) || 1));
  const { items, count, hasMore } = await listUnidentified(staff, { page });
  const selected = items.find((item) => String(item.number) === params.number) ?? null;
  const canWrite = staff.actor.staffRole !== 'product';
  const q = params.q?.trim().slice(0, 100) ?? '';
  const search = selected && canWrite && q ? await searchOrganizations(staff, { query: q }) : null;
  const found = search?.items ?? null;
  const done = DONE.find((code) => code === params.done);
  const error = params.error ? (ERRORS.find((code) => code === params.error) ?? 'other') : null;

  return (
    <>
      <PageHeader
        title={t('queues.unidentified.title')}
        breadcrumbs={[{ label: t('home.title'), href: '/agent' }, { label: t('queues.title'), href: '/agent/queues' }, { label: t('queues.unidentified.title') }]}
        breadcrumbsLabel={t('breadcrumbs')}
      />
      <div className="flex flex-col gap-3">
        <p className="max-w-3xl text-secondary-foreground">{t('queues.unidentified.intro')}</p>
        {done && <Alert tone={done === 'boundNoInvite' ? 'info' : 'success'}>{t(`queues.unidentified.done.${done}`)}</Alert>}
        {error && <Alert tone="danger">{t(`queues.unidentified.errors.${error}`)}</Alert>}
        {count === 0 ? (
          <Card>
            <EmptyState title={t('queues.unidentified.emptyTitle')} text={t('queues.unidentified.emptyText')} />
          </Card>
        ) : (
          <div className="grid gap-4 lg:grid-cols-2">
            <Card>
              <CardContent className="pt-6">
                <ul className="flex flex-col divide-y divide-border" aria-label={t('queues.unidentified.listLabel')}>
                  {items.map((item) => (
                    <li key={item.number} data-number={item.number}>
                      <Link
                        href={`/agent/queues/unidentified?number=${item.number}`}
                        aria-current={selected?.number === item.number ? 'true' : undefined}
                        className={cn('flex flex-col gap-1 rounded-control px-2 py-3 text-sm hover:bg-card-soft', selected?.number === item.number && 'bg-card-soft')}
                      >
                        <span className="flex flex-wrap items-center gap-2">
                          <span className="font-semibold text-link">SUP-{item.number}</span>
                          <span className="break-all">{item.fromAddress ?? ''}</span>
                          <span className="text-muted-foreground">{format.dateTime(item.createdOn, { dateStyle: 'medium', timeStyle: 'short' })}</span>
                        </span>
                        <span className="break-words">{item.title}</span>
                      </Link>
                    </li>
                  ))}
                </ul>
                <div className="flex gap-2 pt-3">
                  {page > 1 && (
                    <Link href={`/agent/queues/unidentified?page=${page - 1}`} className="text-sm text-link hover:underline">
                      {t('queues.prev')}
                    </Link>
                  )}
                  {hasMore && (
                    <Link href={`/agent/queues/unidentified?page=${page + 1}`} className="text-sm text-link hover:underline">
                      {t('queues.next')}
                    </Link>
                  )}
                </div>
              </CardContent>
            </Card>
            {selected ? (
              <BindPanel item={selected} q={q} found={found} tooShort={search?.searchTooShort ?? false} canWrite={canWrite} />
            ) : (
              <Card>
                <CardContent className="pt-6 text-sm text-secondary-foreground">{t('queues.unidentified.choose')}</CardContent>
              </Card>
            )}
          </div>
        )}
      </div>
    </>
  );
}
