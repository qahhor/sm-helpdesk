import { getTranslations } from 'next-intl/server';
import { Card } from '@/ui/components/card';
import { EmptyState } from '@/ui/components/EmptyState';
import { PageHeader } from '@/ui/components/PageHeader';

// Главная рабочего места. Очереди обращений появляются в вехе M3.
export default async function AgentHomePage() {
  const t = await getTranslations('agent');
  return (
    <>
      <PageHeader
        title={t('home.title')}
        breadcrumbs={[{ label: t('home.title') }]}
        breadcrumbsLabel={t('breadcrumbs')}
      />
      <Card>
        <EmptyState title={t('home.emptyTitle')} text={t('home.emptyText')} />
      </Card>
    </>
  );
}
