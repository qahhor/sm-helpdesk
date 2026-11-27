import { getFormatter, getLocale, getTranslations } from 'next-intl/server';
import { Link } from '@/i18n/navigation';
import { isLocale } from '@/i18n/locales';
import { listPublicProblems } from '@/modules/hdp/api/client';
import { requireClientActor } from '@/modules/hdu/api';
import { Card, CardContent } from '@/ui/components/card';
import { EmptyState } from '@/ui/components/EmptyState';
import { StatusLabel } from '@/ui/components/StatusLabel';

// Страница "Известные проблемы" для вошедших клиентов (ТЗ FR-KP-09, 12.1; план M5c, задача 4, решение 16): активные и
// исправленные за последние 30 суток, только публичные название, описание, статус и обходной путь. Без счётчиков и
// организаций. Без кеша: данные читаются при каждом открытии от имени клиента.

export default async function ProblemsPage() {
  const client = await requireClientActor();
  const raw = await getLocale();
  const locale = isLocale(raw) ? raw : 'ru';
  const t = await getTranslations('client.problems');
  const format = await getFormatter();
  const items = await listPublicProblems(client, { locale });
  return (
    <>
      <h1 className="text-2xl font-bold">{t('page.title')}</h1>
      <p className="text-secondary-foreground">{t('page.intro')}</p>
      {items.length === 0 ? (
        <Card>
          <EmptyState withTez title={t('page.empty')} text={t('page.emptyText')} />
        </Card>
      ) : (
        <ul className="flex flex-col gap-3" data-testid="public-problems">
          {items.map((item) => (
            <li key={item.number}>
              <Card>
                <CardContent className="flex flex-col gap-2 pt-4">
                  <p className="flex flex-wrap items-center gap-2">
                    <StatusLabel tone={item.status === 'fixed' ? 'green' : 'orange'}>{item.status === 'fixed' ? t('page.fixed') : t('page.active')}</StatusLabel>
                    <span className="text-sm text-secondary-foreground">{t('status', { status: t(`statuses.${item.status === 'closed' ? 'fixed' : item.status}`) })}</span>
                  </p>
                  <h2 className="break-words text-lg font-semibold">{item.publicTitle}</h2>
                  <p className="whitespace-pre-wrap break-words">{item.publicBody}</p>
                  {item.fixedOn && <p className="text-sm text-secondary-foreground">{t('page.fixedOn', { date: format.dateTime(item.fixedOn, { dateStyle: 'medium' }) })}</p>}
                  {item.workaround && (
                    <p className="flex flex-wrap gap-2 text-sm">
                      <span>{t('workaround')}</span>
                      <Link href={`/help/a/${item.workaround.number}-${item.workaround.slug}`} className="text-link underline underline-offset-2">
                        {item.workaround.title}
                      </Link>
                    </p>
                  )}
                </CardContent>
              </Card>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
