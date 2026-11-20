import { getTranslations } from 'next-intl/server';
import { requireClientActor } from '@/modules/hdu/api';
import { Card } from '@/ui/components/card';
import { EmptyState } from '@/ui/components/EmptyState';

// Идеи по продукту. Сами идеи появляются в вехе M6.
export default async function ClientIdeasPage() {
  await requireClientActor();
  const t = await getTranslations('client');
  return (
    <>
      <h1 className="text-2xl font-bold">{t('nav.ideas')}</h1>
      <Card>
        <EmptyState title={t('ideas.emptyTitle')} text={t('ideas.emptyText')} />
      </Card>
    </>
  );
}
