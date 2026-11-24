import { getTranslations } from 'next-intl/server';
import { QUEUE_KEYS, QUEUE_SORTS, queueHref, type QueueKey, type QueueLocation, type QueueSort, type SavedFilter } from '@/modules/hdt/api';
import { Link } from '@/i18n/navigation';
import { Button } from '@/ui/components/button';
import { cn } from '@/ui/cn';
import { deleteFilterAction } from './actions';

// Боковая панель страницы очередей (FR-AG-01, FR-AG-11): очереди со счётчиками, "Неопознанные", благодарности
// и сохранённые фильтры. Серверный компонент. Вынесен из страницы (аудит 23.11.2026, находка A8).

const pick = <T extends string>(value: unknown, allowed: readonly T[], fallback: T): T => allowed.find((item) => item === value) ?? fallback;

type Props = {
  /** Где сотрудник сейчас: по этому считаются адреса ссылок. */
  location: QueueLocation;
  counts: Record<QueueKey, number | null>;
  filters: SavedFilter[];
  unidentified: number;
};

export async function QueueNav({ location, counts, filters, unidentified }: Props) {
  const t = await getTranslations('agent');
  const { queue } = location;
  const href = (next: Parameters<typeof queueHref>[1]) => queueHref(location, next);

  return (
    <nav aria-label={t('queues.listLabel')} className="flex flex-col gap-4 lg:w-60 lg:shrink-0">
      <ul className="flex flex-wrap gap-1 lg:flex-col">
        {QUEUE_KEYS.map((key) => (
          <li key={key}>
            <Link
              href={href({ queue: key, q: undefined, tag: undefined, page: 1 })}
              aria-current={key === queue ? 'page' : undefined}
              className={cn(
                'flex items-center justify-between gap-3 rounded-control px-3 py-2 text-sm',
                key === queue ? 'bg-card-soft font-semibold text-foreground' : 'text-secondary-foreground hover:bg-card-soft',
              )}
            >
              <span>{t(`queues.names.${key}`)}</span>
              {counts[key] !== null && <span className="tabular-nums">{counts[key]}</span>}
            </Link>
          </li>
        ))}
        <li>
          <Link href="/agent/queues/unidentified" className="flex rounded-control px-3 py-2 text-sm text-secondary-foreground hover:bg-card-soft">
            {t('queues.unidentified.link', { count: unidentified })}
          </Link>
        </li>
        <li>
          <Link href="/agent/queues/thanks" className="flex rounded-control px-3 py-2 text-sm text-secondary-foreground hover:bg-card-soft">
            {t('queues.thanks.link')}
          </Link>
        </li>
      </ul>
      {filters.length > 0 && (
        <section aria-labelledby="saved-filters" className="flex flex-col gap-1">
          <h2 id="saved-filters" className="px-3 text-xs font-medium text-secondary-foreground">
            {t('queues.savedTitle')}
          </h2>
          <ul className="flex flex-col gap-1">
            {filters.map((filter) => (
              <li key={filter.filterId} className="flex items-center justify-between gap-2">
                <Link
                  href={href({ queue: pick<QueueKey>(filter.query.queue, QUEUE_KEYS, 'all'), sort: pick<QueueSort>(filter.query.sort, QUEUE_SORTS, 'sla'), q: filter.query.q, tag: undefined, page: 1 })}
                  className="rounded-control px-3 py-1 text-sm text-link hover:underline"
                >
                  {filter.name}
                  {filter.isShared && <span className="ms-1 text-xs text-muted-foreground">{t('queues.shared')}</span>}
                </Link>
                {filter.isMine && (
                  <form action={deleteFilterAction}>
                    <input type="hidden" name="filterId" value={filter.filterId} />
                    <input type="hidden" name="queue" value={queue} />
                    <Button type="submit" variant="ghost" size="small" aria-label={t('queues.deleteFilter', { name: filter.name })}>
                      {t('queues.delete')}
                    </Button>
                  </form>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}
    </nav>
  );
}
