import { getFormatter, getLocale, getTranslations } from 'next-intl/server';
import { Link } from '@/i18n/navigation';
import type { Locale } from '@/i18n/locales';
import { cycleCountdown, cycleMonth, ideaRef } from '@/modules/hdi/api/constants';
import { clientCycleArchive } from '@/modules/hdi/api/cycles';
import { requireClientActor } from '@/modules/hdu/api';
import { Card } from '@/ui/components/card';
import { EmptyState } from '@/ui/components/EmptyState';
import { StatusLabel } from '@/ui/components/StatusLabel';

// Отбор месяца у клиента (ТЗ FR-IDEA-16; план M7, задача 9, решение 17): обратный отсчёт до ближайшего 1-го числа
// 09:00 по Ташкенту и архив прошлых выборов с объяснениями на языке клиента (иначе русское) и пометкой "без выбора".
// Объяснение пишет и сохраняет сотрудник Smartup; кто выбрал, страница не показывает. Скриптов на странице нет.

export default async function IdeaCyclesPage() {
  const client = await requireClientActor();
  const locale = (await getLocale()) as Locale;
  const t = await getTranslations('client.ideas');
  const format = await getFormatter();
  const archive = await clientCycleArchive(client, { locale });
  const countdown = cycleCountdown(new Date());
  const monthName = (date: Date) => format.dateTime(date, { month: 'long', year: 'numeric', timeZone: 'UTC' });

  return (
    <>
      <Link href="/ideas" className="self-start text-sm text-link underline-offset-2 hover:underline">
        {t('new.back')}
      </Link>
      <h1 className="text-2xl font-bold">{t('cycles.title')}</h1>
      <p className="text-secondary-foreground">{t('cycles.intro')}</p>
      <p className="rounded-card border border-border bg-card-soft px-4 py-3 text-sm" data-testid="cycles-countdown">
        {t('cycles.countdown', {
          month: format.dateTime(countdown.month, { month: 'long', timeZone: 'UTC' }),
          days: countdown.daysLeft,
          date: format.dateTime(countdown.endsOn, { dateStyle: 'long', timeStyle: 'short', timeZone: 'Asia/Tashkent' }),
        })}
      </p>
      <section aria-labelledby="cycles-archive" className="flex flex-col gap-3">
        <h2 id="cycles-archive" className="text-lg font-semibold">
          {t('cycles.archiveTitle')}
        </h2>
        {archive.length === 0 ? (
          <Card>
            <EmptyState title={t('cycles.archiveEmpty')} text={t('cycles.archiveEmptyText')} />
          </Card>
        ) : (
          <ul className="flex flex-col gap-3" data-testid="cycles-archive">
            {archive.map((item) => (
              <li key={item.cycle} data-cycle={item.cycle} className="flex flex-col gap-2 rounded-card border border-border bg-card p-3">
                <p className="font-semibold">{t('cycles.cycleOf', { month: monthName(cycleMonth(item.cycle)) })}</p>
                {item.idea ? (
                  <>
                    <Link href={`/ideas/${item.idea.number}`} className="break-words text-link underline-offset-2 hover:underline">
                      {ideaRef(item.idea.number)} {item.idea.title}
                    </Link>
                    {item.explanation && (
                      <div className="flex flex-col gap-1 text-sm">
                        <span className="text-secondary-foreground">{t('cycles.explanation')}</span>
                        <p className="whitespace-pre-wrap break-words" lang={item.explanationLocale}>
                          {item.explanation}
                        </p>
                      </div>
                    )}
                  </>
                ) : (
                  <span>
                    <StatusLabel tone="gray">{t('cycles.noChoice')}</StatusLabel>
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}
