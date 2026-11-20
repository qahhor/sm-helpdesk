import { getTranslations } from 'next-intl/server';
import { requireClientActor } from '@/modules/hdu/api';
import { Card } from '@/ui/components/card';
import { EmptyState } from '@/ui/components/EmptyState';

// Список обращений клиента. Сами обращения появляются в вехе M2.
export default async function ClientTicketsPage() {
  await requireClientActor();
  const t = await getTranslations('client');
  return (
    <>
      <h1 className="text-2xl font-bold">{t('nav.tickets')}</h1>
      <Card>
        <EmptyState withTez title={t('tickets.emptyTitle')} text={t('tickets.emptyText')} />
      </Card>
    </>
  );
}
