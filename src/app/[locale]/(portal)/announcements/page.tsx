import { getFormatter, getLocale, getNow, getTranslations } from 'next-intl/server';
import { isLocale } from '@/i18n/locales';
import { announcementArchive } from '@/modules/hdp/api/announcements';
import { requireClientActor } from '@/modules/hdu/api';
import { AnnouncementBanner } from '@/ui/components/AnnouncementBanner';
import { Card } from '@/ui/components/card';
import { EmptyState } from '@/ui/components/EmptyState';

// Архив объявлений (ТЗ FR-ANN-04, 12.1; план M5c, задача 6, решение 24): действующие и закончившиеся за 90 суток
// объявления аудитории клиента, новые сверху. Закрытые баннеры здесь тоже видны. Без кеша.

export default async function AnnouncementsPage() {
  const client = await requireClientActor();
  const raw = await getLocale();
  const locale = isLocale(raw) ? raw : 'ru';
  const t = await getTranslations('client.announcements');
  const format = await getFormatter();
  const items = await announcementArchive(client, { locale });
  const now = (await getNow()).getTime();
  return (
    <>
      <h1 className="text-2xl font-bold">{t('title')}</h1>
      {items.length === 0 ? (
        <Card>
          <EmptyState withTez title={t('empty')} text={t('emptyText')} />
        </Card>
      ) : (
        <ul className="flex flex-col gap-3" data-testid="announcements-archive">
          {items.map((a) => (
            <li key={a.announcementId} className="flex flex-col gap-1">
              <p className="text-sm text-secondary-foreground">
                {t(a.endsOn.getTime() > now ? 'activeUntil' : 'ended', {
                  start: format.dateTime(a.startsOn, { dateStyle: 'medium', timeStyle: 'short' }),
                  end: format.dateTime(a.endsOn, { dateStyle: 'medium', timeStyle: 'short' }),
                })}
              </p>
              <AnnouncementBanner kind={a.kind} kindLabel={t(`kinds.${a.kind}`)} title={a.title} body={a.body} />
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
