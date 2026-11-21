import { getTranslations } from 'next-intl/server';
import { requireStaffActor } from '@/modules/hdu/api';
import { Link } from '@/i18n/navigation';
import { buttonVariants } from '@/ui/components/button';
import { Card } from '@/ui/components/card';
import { EmptyState } from '@/ui/components/EmptyState';
import { PageHeader } from '@/ui/components/PageHeader';

// Главная рабочего места: работа начинается с очередей (веха M3).
export default async function AgentHomePage() {
  await requireStaffActor();
  const t = await getTranslations('agent');
  return (
    <>
      <PageHeader
        title={t('home.title')}
        breadcrumbs={[{ label: t('home.title') }]}
        breadcrumbsLabel={t('breadcrumbs')}
      />
      <Card>
        <EmptyState
          title={t('home.emptyTitle')}
          text={t('home.emptyText')}
          action={
            <Link href="/agent/queues" className={buttonVariants()}>
              {t('home.openQueues')}
            </Link>
          }
        />
      </Card>
    </>
  );
}
