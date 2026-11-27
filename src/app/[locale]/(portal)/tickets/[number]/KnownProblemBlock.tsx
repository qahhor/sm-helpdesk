import { getLocale, getTranslations } from 'next-intl/server';
import { Link } from '@/i18n/navigation';
import { isLocale } from '@/i18n/locales';
import { publicProblemOfTicket } from '@/modules/hdp/api/client';
import type { ClientContext } from '@/modules/hdu/api';
import { KnownProblemBanner } from '@/ui/components/KnownProblemBanner';

// Блок "Известная проблема" в обращении клиента (ТЗ FR-KP-05; план M5c, задача 4, решение 15): публичное название,
// статус, обходной путь ссылкой на опубликованное решение. Только из представления hdp_problems_public: проблема без
// признака показа клиенту не видна, блока нет. Названий других организаций и счётчиков здесь нет. Тез в позе "Вираж"
// (состояние "Внимание", раздел 8.13) через TezMark внутри баннера.

export async function KnownProblemBlock({ client, number }: { client: ClientContext; number: number }) {
  const raw = await getLocale();
  const locale = isLocale(raw) ? raw : 'ru';
  const problem = await publicProblemOfTicket(client, { ticketNumber: number, locale });
  if (!problem) return null;
  const t = await getTranslations('client.problems');
  return (
    <KnownProblemBanner
      testId="ticket-known-problem"
      heading={t('heading')}
      title={problem.publicTitle}
      status={t('status', { status: t(`statuses.${problem.status === 'closed' ? 'fixed' : problem.status}`) })}
      body={t('inTicket')}
      workaround={
        problem.workaround
          ? {
              label: t('workaround'),
              link: (
                <Link href={`/help/a/${problem.workaround.number}-${problem.workaround.slug}`} className="text-link underline underline-offset-2">
                  {problem.workaround.title}
                </Link>
              ),
            }
          : null
      }
    />
  );
}
