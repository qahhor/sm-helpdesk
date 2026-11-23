import { getFormatter, getTranslations } from 'next-intl/server';
import { Link } from '@/i18n/navigation';
import { getAgentTicket } from '@/modules/hdt/api';
import type { StaffContext } from '@/modules/hdu/api';
import { buttonVariants } from '@/ui/components/button';
import { Card, CardContent } from '@/ui/components/card';
import { Markdown } from '@/ui/components/markdown';
import { StatusLabel } from '@/ui/components/StatusLabel';
import { STATUS_TONE } from '@/ui/ticket-status';

// Обращение рядом со списком (UX-A-01): только на широком экране. Стрелки в очереди открывают здесь соседнее
// обращение, полная страница по кнопке. Просмотр рядом не отмечает визит: отметку ставит полная страница.

export async function QueuePreview({ number, queue, sort, staff }: { number: number | null; queue: string; sort: string; staff: StaffContext }) {
  const t = await getTranslations('agent');
  const format = await getFormatter();
  const ticket = number ? await getAgentTicket(staff, number) : null;
  const last = ticket?.timeline.filter((entry) => entry.type === 'message').at(-1);
  return (
    <aside data-preview-pane aria-label={t('queues.preview.label')} className="hidden wide:block wide:w-1/3 wide:shrink-0">
      <Card>
        <CardContent className="flex flex-col gap-3 pt-6">
          {!ticket ? (
            <p className="text-sm text-muted-foreground">{t('queues.preview.empty')}</p>
          ) : (
            <>
              <h2 className="font-semibold">
                SUP-{ticket.number} {ticket.title}
              </h2>
              <p className="flex flex-wrap items-center gap-2 text-sm">
                <StatusLabel tone={STATUS_TONE[ticket.status] ?? 'gray'}>{t(`queues.statuses.${ticket.status}`)}</StatusLabel>
                <span className="font-semibold">{ticket.priority.toUpperCase()}</span>
                <span>{ticket.org?.name ?? ''}</span>
              </p>
              <Markdown text={ticket.description} />
              {last && last.type === 'message' && (
                <div className="flex flex-col gap-1 border-t border-border pt-3 text-sm" data-internal={last.isInternal ? '' : undefined}>
                  <p className="flex flex-wrap items-center gap-2 text-muted-foreground">
                    {/* Заметку клиент не видит: без отметки её легко принять за ответ клиенту (M3, мелкое 8). */}
                    {last.isInternal && <StatusLabel tone="orange">{t('ticket.note')}</StatusLabel>}
                    <span>
                      {last.authorName ?? t(`ticket.authors.${last.authorType}`)}, {format.dateTime(last.createdOn, { dateStyle: 'medium', timeStyle: 'short' })}
                    </span>
                  </p>
                  <Markdown text={last.body} />
                </div>
              )}
              <Link href={`/agent/tickets/SUP-${ticket.number}?queue=${queue}&sort=${sort}`} className={buttonVariants({ variant: 'secondary' })}>
                {t('queues.preview.open')}
              </Link>
            </>
          )}
        </CardContent>
      </Card>
    </aside>
  );
}
