import { getTranslations } from 'next-intl/server';
import { requireClientActor } from '@/modules/hdu/api';
import { Link } from '@/i18n/navigation';
import { Button } from '@/ui/components/button';
import { Card } from '@/ui/components/card';
import { EmptyState } from '@/ui/components/EmptyState';

// Главная кабинета клиента: один вопрос и одно главное действие (UX-C-01).
// Поле описания проблемы появится в вехе M2.
export default async function ClientHomePage() {
  await requireClientActor();
  const t = await getTranslations('client');
  return (
    <>
      <h1 className="text-2xl font-bold">{t('home.title')}</h1>
      <div className="flex flex-col gap-3 tablet:flex-row">
        <Button asChild>
          <Link href="/tickets">{t('home.report')}</Link>
        </Button>
        <Button asChild variant="secondary">
          <Link href="/ideas">{t('home.idea')}</Link>
        </Button>
      </div>
      <Card>
        <EmptyState withTez title={t('home.myTickets')} text={t('tickets.empty')} />
      </Card>
    </>
  );
}
