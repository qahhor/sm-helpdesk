import { getTranslations } from 'next-intl/server';
import { queueSidebar } from '@/modules/hdt/api';
import { requireStaffActor } from '@/modules/hdu/api';
import { Link } from '@/i18n/navigation';
import { buttonVariants } from '@/ui/components/button';
import { Card } from '@/ui/components/card';
import { EmptyState } from '@/ui/components/EmptyState';
import { PageHeader } from '@/ui/components/PageHeader';

/** Очереди, с которых сотрудник начинает день (проверка интерфейса, U12). */
const HOME_QUEUES = ['mine', 'new', 'breached'] as const;

// Главная рабочего места: работа начинается с очередей (веха M3). Счётчики показывают, что ждёт прямо сейчас.
export default async function AgentHomePage() {
  const staff = await requireStaffActor();
  const { counts } = await queueSidebar(staff);
  const t = await getTranslations('agent');
  return (
    <>
      <PageHeader
        title={t('home.title')}
        breadcrumbs={[{ label: t('home.title') }]}
        breadcrumbsLabel={t('breadcrumbs')}
      />
      <section aria-labelledby="home-counters" className="flex flex-col gap-3" data-testid="home-counters">
        <h2 id="home-counters" className="text-base font-semibold">
          {t('home.countersTitle')}
        </h2>
        <ul className="grid grid-cols-1 gap-3 tablet:grid-cols-3">
          {HOME_QUEUES.map((queue) => (
            <li key={queue}>
              <Link href={`/agent/queues?queue=${queue}`} className="flex flex-col gap-1 rounded-card border border-border bg-card p-4 hover:bg-card-soft" data-queue={queue}>
                <span className="text-sm text-secondary-foreground">{t(`queues.names.${queue}`)}</span>
                <span className="text-2xl font-bold tabular-nums">{counts[queue] ?? t('metrics.none')}</span>
              </Link>
            </li>
          ))}
        </ul>
      </section>
      <Card>
        <EmptyState
          title={t('home.emptyTitle')}
          text={t('home.emptyText')}
          action={
            <div className="flex flex-wrap justify-center gap-2">
              <Link href="/agent/queues" className={buttonVariants()}>
                {t('home.openQueues')}
              </Link>
              <Link href="/agent/playbooks" className={buttonVariants({ variant: 'secondary' })}>
                {t('home.openPlaybooks')}
              </Link>
            </div>
          }
        />
      </Card>
    </>
  );
}
