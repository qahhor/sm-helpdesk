import { Button } from '@/ui/components/button';
import { Card, CardContent } from '@/ui/components/card';
import { EmptyState } from '@/ui/components/EmptyState';

// Список уведомлений (FR-NT-03, решение 5 вехи M4) для кабинета клиента и рабочего места. Тексты уже переведены
// на сервере. Открытие уведомления это форма: работает без JavaScript, отметка прочтения ставится на сервере.

export type NotificationItem = { id: string; text: string; time: string; unread: boolean };

export function NotificationsList({
  items,
  labels,
  open,
  markAll,
  moreHref,
}: {
  items: NotificationItem[];
  labels: { empty: string; emptyText: string; markAll: string; unread: string; more: string };
  open: (formData: FormData) => Promise<void>;
  markAll: () => Promise<void>;
  moreHref: string | null;
}) {
  if (items.length === 0) return <EmptyState title={labels.empty} text={labels.emptyText} />;
  return (
    <div className="flex flex-col gap-4">
      {items.some((item) => item.unread) && (
        <form action={markAll} className="self-end">
          <Button type="submit" variant="secondary">
            {labels.markAll}
          </Button>
        </form>
      )}
      <Card>
        <CardContent className="p-0">
          <ul className="divide-y divide-border">
            {items.map((item) => (
              <li key={item.id}>
                <form action={open}>
                  <input type="hidden" name="id" value={item.id} />
                  <button
                    type="submit"
                    data-notification={item.id}
                    className="flex w-full items-start gap-3 px-4 py-3 text-start outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                  >
                    <span className="flex min-w-0 flex-1 flex-col gap-1">
                      <span className={item.unread ? 'font-semibold' : undefined}>{item.text}</span>
                      <span className="text-sm text-secondary-foreground">{item.time}</span>
                    </span>
                    {item.unread && <span className="rounded-chip bg-primary px-2 text-xs font-bold text-primary-foreground">{labels.unread}</span>}
                  </button>
                </form>
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>
      {moreHref && (
        <a href={moreHref} className="self-center text-link underline">
          {labels.more}
        </a>
      )}
    </div>
  );
}
