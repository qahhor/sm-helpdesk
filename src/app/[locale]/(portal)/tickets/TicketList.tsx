import { Link } from '@/i18n/navigation';
import { StatusLabel } from '@/ui/components/StatusLabel';
import { STATUS_TONE } from './status';

// Строки списка обращений: номер, тема, статус словами и время изменения. Используется списком и главной.

export type TicketListItem = { number: number; title: string; status: string; statusLabel: string; when: string; privateLabel: string | null };

export function TicketList({ items }: { items: TicketListItem[] }) {
  return (
    <ul className="flex flex-col divide-y divide-border">
      {items.map((item) => (
        <li key={item.number}>
          <Link href={`/tickets/SUP-${item.number}`} className="flex min-h-row flex-col gap-1 px-4 py-3 outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring">
            <span className="flex min-w-0 items-baseline gap-2">
              <span className="shrink-0 text-sm font-semibold text-secondary-foreground">SUP-{item.number}</span>
              <span className="min-w-0 break-words font-medium">{item.title}</span>
            </span>
            <span className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
              <StatusLabel tone={STATUS_TONE[item.status] ?? 'gray'}>{item.statusLabel}</StatusLabel>
              {item.privateLabel && <span>{item.privateLabel}</span>}
              <span>{item.when}</span>
            </span>
          </Link>
        </li>
      ))}
    </ul>
  );
}
