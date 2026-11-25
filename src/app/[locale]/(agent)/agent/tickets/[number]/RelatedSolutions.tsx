import { getTranslations } from 'next-intl/server';
import { env } from '@/env';
import { Link } from '@/i18n/navigation';
import { relatedSolutions } from '@/modules/hdk/api/suggest';
import type { StaffContext } from '@/modules/hdu/api';
import { Card, CardContent } from '@/ui/components/card';
import { InsertSolutionLink } from './InsertSolutionLink';

// "Связанные решения" на странице обращения сотрудника (FR-AG-05; план M5, задача 10): поиск по сигнатуре и теме
// обращения среди решений для клиентов и "только через сотрудника". Ссылку в ответ можно вставить только на решение
// для клиентов: внутреннее клиент не откроет, его сотрудник пересказывает сам.

export async function RelatedSolutions({ staff, ticketId, locale, canWrite }: { staff: StaffContext; ticketId: string; locale: string; canWrite: boolean }) {
  const items = await relatedSolutions(staff, { ticketId });
  if (items.length === 0) return null;
  const t = await getTranslations('agent.ticket.related');
  const lang = ['ru', 'uz', 'en'].includes(locale) ? locale : 'ru';
  return (
    <Card data-testid="related-solutions">
      <CardContent className="flex flex-col gap-2 pt-6 text-sm">
        <h2 className="text-xs font-medium text-secondary-foreground">{t('title')}</h2>
        <ul className="flex flex-col gap-3">
          {items.map((item) => (
            <li key={item.number} className="flex flex-col items-start gap-1">
              {item.exact && <span className="text-xs font-semibold text-secondary-foreground">{t('exact')}</span>}
              <Link href={`/agent/solutions/${item.number}`} className="font-semibold text-link underline">
                {item.title}
              </Link>
              {item.audience === 'internal' ? (
                <span className="text-secondary-foreground">{t('internal')}</span>
              ) : (
                canWrite && <InsertSolutionLink text={`${env.HUB_URL}/${lang}/help/a/${item.number}-${item.slug}`} label={t('insert')} />
              )}
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}
