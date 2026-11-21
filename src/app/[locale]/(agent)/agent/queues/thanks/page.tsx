import { getFormatter, getTranslations } from 'next-intl/server';
import { Link } from '@/i18n/navigation';
import { listThanks } from '@/modules/hdt/api';
import { requireStaffActor } from '@/modules/hdu/api';
import { Card, CardContent } from '@/ui/components/card';
import { EmptyState } from '@/ui/components/EmptyState';
import { PageHeader } from '@/ui/components/PageHeader';

// "Не открыли обращение" (FR-TK-14): ответы клиентов на решённые обращения, которые распознаны как благодарность
// и обращение заново не открыли. Сотрудник проверяет, не пропущен ли за "спасибо" новый вопрос.

export default async function ThanksPage({ searchParams }: { searchParams: Promise<{ page?: string }> }) {
  const staff = await requireStaffActor();
  const t = await getTranslations('agent');
  const format = await getFormatter();
  const page = Math.max(1, Math.min(1000, Number((await searchParams).page) || 1));
  const { items, hasMore } = await listThanks(staff, { page });
  return (
    <>
      <PageHeader
        title={t('queues.thanks.title')}
        breadcrumbs={[{ label: t('home.title'), href: '/agent' }, { label: t('queues.title'), href: '/agent/queues' }, { label: t('queues.thanks.title') }]}
        breadcrumbsLabel={t('breadcrumbs')}
      />
      <div className="flex max-w-3xl flex-col gap-3">
        <p className="text-secondary-foreground">{t('queues.thanks.intro')}</p>
        {items.length === 0 ? (
          <Card>
            <EmptyState title={t('queues.thanks.emptyTitle')} text={t('queues.thanks.emptyText')} />
          </Card>
        ) : (
          <Card>
            <CardContent className="pt-6">
              <ul className="flex flex-col divide-y divide-border">
                {items.map((item) => (
                  <li key={`${item.number}-${item.createdOn.getTime()}`} className="flex flex-col gap-1 py-3" data-number={item.number}>
                    <p className="flex flex-wrap items-center gap-2 text-sm">
                      <Link href={`/agent/tickets/SUP-${item.number}`} className="font-semibold text-link hover:underline">
                        SUP-{item.number}
                      </Link>
                      <span>{item.orgName}</span>
                      <span className="text-muted-foreground">{format.dateTime(item.createdOn, { dateStyle: 'medium', timeStyle: 'short' })}</span>
                    </p>
                    <p className="break-words">{item.body}</p>
                  </li>
                ))}
              </ul>
            </CardContent>
          </Card>
        )}
        <div className="flex gap-2">
          {page > 1 && (
            <Link href={`/agent/queues/thanks?page=${page - 1}`} className="text-sm text-link hover:underline">
              {t('queues.prev')}
            </Link>
          )}
          {hasMore && (
            <Link href={`/agent/queues/thanks?page=${page + 1}`} className="text-sm text-link hover:underline">
              {t('queues.next')}
            </Link>
          )}
        </div>
      </div>
    </>
  );
}
