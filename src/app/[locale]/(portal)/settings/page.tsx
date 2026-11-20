import { getTranslations } from 'next-intl/server';
import { requireClientActor } from '@/modules/hdu/api';
import { Card } from '@/ui/components/card';
import { EmptyState } from '@/ui/components/EmptyState';

// Профиль клиента. Данные профиля появляются вместе со входом в вехе M1.
export default async function ClientSettingsPage() {
  await requireClientActor();
  const t = await getTranslations('client');
  return (
    <>
      <h1 className="text-2xl font-bold">{t('nav.profile')}</h1>
      <Card>
        <EmptyState title={t('profile.emptyTitle')} text={t('profile.emptyText')} />
      </Card>
    </>
  );
}
