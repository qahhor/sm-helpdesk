import { getFormatter, getLocale, getTranslations } from 'next-intl/server';
import type { Locale } from '@/i18n/locales';
import { ideaOfMonth } from '@/modules/hdi/api/board';
import { ideaRef } from '@/modules/hdi/api/constants';
import { listTickets } from '@/modules/hdt/api';
import { hintsPending, requireClientActor } from '@/modules/hdu/api';
import { Link } from '@/i18n/navigation';
import { AnnouncementBanners } from './announcements-view';
import { Button } from '@/ui/components/button';
import { Card } from '@/ui/components/card';
import { EmptyState } from '@/ui/components/EmptyState';
import { StatusLabel } from '@/ui/components/StatusLabel';
import { IDEA_STATUS_TONE } from '../idea-status';
import { dismissHintsAction } from './actions';
import { TicketList } from './tickets/TicketList';

// Главная кабинета клиента: один вопрос и одно главное действие (UX-C-01), три последних обращения,
// подсказки первого входа до нажатия "Понятно" (UX-C-14), блок "Идея месяца" (ТЗ 8.3, план M7, задача 5) без скриптов:
// он не добавляет кода в бюджет главной. Поле описания на главной появится с подсказками решений (M5).
export default async function ClientHomePage() {
  const client = await requireClientActor();
  const t = await getTranslations('client');
  const format = await getFormatter();
  const locale = (await getLocale()) as Locale;
  const ti = await getTranslations('client.ideas');
  const tp = await getTranslations('client.problems');
  const [recent, hints, month] = await Promise.all([listTickets(client, { scope: 'mine' }), hintsPending(client), ideaOfMonth(client, { locale })]);
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
          <Link href="/ideas/new">{t('home.idea')}</Link>
        </Button>
      </div>
      {/* Объявления модуля на главной видят все клиенты (решение 24): портал не знает, какими модулями пользуется клиент. */}
      <AnnouncementBanners client={client} only="module" />
      <div className="flex flex-wrap gap-x-4 gap-y-1">
        <Link href="/problems" className="text-sm text-link underline underline-offset-2">
          {tp('homeLink')}
        </Link>
        <Link href="/announcements" className="text-sm text-link underline underline-offset-2">
          {tp('announcementsLink')}
        </Link>
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
      {month && (
        <section aria-labelledby="idea-of-month" className="flex flex-col gap-2" data-testid="idea-of-month">
          <h2 id="idea-of-month" className="text-lg font-semibold">
            {ti('month.title')}
          </h2>
          <Link href={`/ideas/${month.card.number}`} className="flex gap-3 rounded-card border border-border bg-card p-3 hover:bg-card-soft">
            <span className="flex min-w-control flex-col items-center font-semibold tabular-nums" aria-label={ti('board.votes', { count: month.card.score })}>
              <span aria-hidden="true">^</span>
              <span aria-hidden="true">{month.card.score}</span>
            </span>
            <span className="flex min-w-0 flex-col gap-1">
              <span className="break-words font-semibold text-link">{month.card.title}</span>
              <span className="text-sm text-secondary-foreground">
                {ideaRef(month.card.number)}
                {month.card.isMachine ? ` · ${ti('machine')}` : ''}
              </span>
              <StatusLabel tone={IDEA_STATUS_TONE[month.card.status]} className="self-start">
                {ti(`statuses.${month.card.status}`)}
              </StatusLabel>
            </span>
          </Link>
        </section>
      )}
    </>
  );
}
