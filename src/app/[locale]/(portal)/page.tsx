import { getFormatter, getTranslations } from 'next-intl/server';
import { listTickets } from '@/modules/hdt/api';
import { hintsPending, requireClientActor } from '@/modules/hdu/api';
import { Link } from '@/i18n/navigation';
import { Button } from '@/ui/components/button';
import { Card } from '@/ui/components/card';
import { EmptyState } from '@/ui/components/EmptyState';
import { dismissHintsAction } from './actions';
import { TicketList } from './tickets/TicketList';

// Главная кабинета клиента: один вопрос и одно главное действие (UX-C-01), три последних обращения,
// подсказки первого входа до нажатия "Понятно" (UX-C-14). Поле описания на главной появится с подсказками решений (M5).
export default async function ClientHomePage() {
  const client = await requireClientActor();
  const t = await getTranslations('client');
  const format = await getFormatter();
  const [recent, hints] = await Promise.all([listTickets(client, { scope: 'mine' }), hintsPending(client)]);
  const items = recent.items.slice(0, 3);
  return (
    <>
      <h1 className="text-2xl font-bold">{t('home.title')}</h1>
      {hints && (
        <section aria-label={t('home.hints.label')} className="flex flex-col gap-2 rounded-card border border-border bg-card-soft p-4">
          <ul className="flex list-disc flex-col gap-1 ps-5">
            <li>{t('home.hints.report')}</li>
            <li>{t('home.hints.turn')}</li>
            <li>{t('home.hints.visibility')}</li>
          </ul>
          <form action={dismissHintsAction}>
            <Button type="submit" variant="secondary" size="small">
              {t('home.hints.ok')}
            </Button>
          </form>
        </section>
      )}
      <div className="flex flex-col gap-3 tablet:flex-row">
        <Button asChild>
          <Link href="/tickets/new">{t('home.report')}</Link>
        </Button>
        <Button asChild variant="secondary">
          <Link href="/ideas">{t('home.idea')}</Link>
        </Button>
      </div>
      <Card>
        {items.length === 0 ? (
          <EmptyState withTez title={t('home.myTickets')} text={t('tickets.empty')} />
        ) : (
          <>
            <div className="flex items-center justify-between px-4 pt-4">
              <h2 className="text-lg font-semibold">{t('home.myTickets')}</h2>
              <Link href="/tickets?scope=mine" className="text-sm text-link underline-offset-2 hover:underline">
                {t('home.all')}
              </Link>
            </div>
            <TicketList
              items={items.map((item) => ({
                number: item.number,
                title: item.title,
                status: item.status,
                statusLabel: t(`tickets.statuses.${item.status}`),
                when: format.relativeTime(item.modifiedOn),
                privateLabel: item.visibility === 'private' ? t('tickets.list.private') : null,
              }))}
            />
          </>
        )}
      </Card>
    </>
  );
}
