import { getLocale, getTranslations } from 'next-intl/server';
import { isLocale } from '@/i18n/locales';
import { activeAnnouncements, type ClientAnnouncement } from '@/modules/hdp/api/announcements';
import type { ClientContext } from '@/modules/hdu/api';
import { AnnouncementBanner, DismissIcon } from '@/ui/components/AnnouncementBanner';
import { Button } from '@/ui/components/button';
import { dismissAnnouncementAction } from './actions';

// Баннеры объявлений в кабинете клиента (FR-ANN-02, 04; план M5c, задача 6, решение 24). В оболочке всех страниц
// объявления для всех и для сервера клиента; объявления модуля на главной (их видят все клиенты) и над формой нового
// обращения при выбранном модуле. Закрытие хранится в базе и действует и в виджете.

export async function AnnouncementBanners({ client, only }: { client: ClientContext; only: 'general' | 'module' }) {
  const raw = await getLocale();
  const locale = isLocale(raw) ? raw : 'ru';
  const list = (await activeAnnouncements(client.actor, { locale, surface: only === 'general' ? 'form' : 'portal' }).catch(() => [] as ClientAnnouncement[])).filter((a) =>
    only === 'general' ? a.audience !== 'module' : a.audience === 'module',
  );
  if (list.length === 0) return null;
  const t = await getTranslations('client.announcements');
  return (
    <div className="flex flex-col gap-2" data-testid={`announcements-${only}`}>
      {list.map((a) => (
        <AnnouncementBanner
          key={a.announcementId}
          kind={a.kind}
          kindLabel={t(`kinds.${a.kind}`)}
          title={a.title}
          body={a.body}
          dismiss={
            <form action={dismissAnnouncementAction}>
              <input type="hidden" name="announcementId" value={a.announcementId} />
              <Button type="submit" variant="ghost" size="small" aria-label={t('dismiss', { title: a.title })}>
                <DismissIcon />
              </Button>
            </form>
          }
        />
      ))}
    </div>
  );
}
