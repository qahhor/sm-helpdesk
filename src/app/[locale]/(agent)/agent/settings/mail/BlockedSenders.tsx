import { getFormatter, getTranslations } from 'next-intl/server';
import { Button } from '@/ui/components/button';
import { Card, CardContent } from '@/ui/components/card';
import { unblockAction } from './actions';

// Отклонённые как спам (решение 14): адреса, письма с которых сохраняются без обращения. Удаление возвращает приём.

export async function BlockedSenders({ senders }: { senders: { address: string; createdOn: Date }[] }) {
  const t = await getTranslations('agent.settings.mail.blocked');
  const format = await getFormatter();
  return (
    <section aria-labelledby="mail-blocked" className="flex flex-col gap-3">
      <h2 id="mail-blocked" className="text-lg font-semibold">
        {t('title')}
      </h2>
      <p className="text-secondary-foreground">{t('intro')}</p>
      <Card>
        <CardContent className="pt-6">
          {senders.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t('empty')}</p>
          ) : (
            <ul className="flex flex-col divide-y divide-border" aria-label={t('title')}>
              {senders.map((sender) => (
                <li key={sender.address} className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm">
                  <span>
                    <span className="break-all font-semibold">{sender.address}</span>{' '}
                    <span className="text-muted-foreground">{t('since', { time: format.dateTime(sender.createdOn, { dateStyle: 'medium' }) })}</span>
                  </span>
                  <form action={unblockAction}>
                    <input type="hidden" name="address" value={sender.address} />
                    <Button type="submit" variant="secondary" size="small">
                      {t('remove')}
                    </Button>
                  </form>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </section>
  );
}
