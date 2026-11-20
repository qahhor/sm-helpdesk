import { getLocale, getTranslations } from 'next-intl/server';
import { formatDate } from '@/i18n/format';
import type { Locale } from '@/i18n/locales';
import { Alert } from '@/ui/components/alert';
import { Button, buttonVariants } from '@/ui/components/button';
import { Card, CardContent, CardHeader } from '@/ui/components/card';
import { unlinkTelegramAction } from './actions';

/**
 * Раздел профиля "Telegram" (FR-ID-14, решение 0018): привязка аккаунта для запасного входа через бота.
 * Показывается, только когда бот включён. Привязка открывает бота в новой вкладке: профиль остаётся открытым.
 */
export async function ChannelsSection({ link, status }: { link: { displayName: string; linkedOn: Date } | null; status?: string }) {
  const t = await getTranslations('client.settings.channels');
  const locale = (await getLocale()) as Locale;
  return (
    <Card>
      <CardHeader>
        <h2 className="text-lg font-semibold">{t('title')}</h2>
        {!link && <p className="text-secondary-foreground">{t('intro')}</p>}
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {status === 'unlinked' && <Alert tone="success">{t('unlinked')}</Alert>}
        {(status === 'rate_limited' || status === 'disabled') && <Alert tone="danger">{t(`errors.${status}`)}</Alert>}
        {link ? (
          <form action={unlinkTelegramAction} className="flex flex-col gap-3 tablet:flex-row tablet:items-center tablet:justify-between">
            <p>{t('linked', { account: link.displayName, date: formatDate(link.linkedOn, locale) })}</p>
            <Button type="submit" variant="secondary" className="self-start">
              {t('unlink')}
            </Button>
          </form>
        ) : (
          <>
            <a href={`/${locale}/settings/telegram`} target="_blank" rel="noopener" className={buttonVariants({ variant: 'secondary', className: 'self-start' })}>
              {t('link')}
            </a>
            <p className="text-sm text-secondary-foreground">{t('hint')}</p>
          </>
        )}
      </CardContent>
    </Card>
  );
}
