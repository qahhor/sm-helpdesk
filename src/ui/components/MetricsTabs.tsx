import { Link } from '@/i18n/navigation';

// Вкладки страницы показателей (план M9, задача 3): "Все показатели" и "Пилот". Обычные ссылки с aria-current,
// работают без скриптов. Вкладку пилота видят только те, кому её показывает страница.

type Props = { current: 'all' | 'pilot'; query: string; label: string; allLabel: string; pilotLabel: string; showPilot: boolean };

export function MetricsTabs({ current, query, label, allLabel, pilotLabel, showPilot }: Props) {
  if (!showPilot) return null;
  const tab = (key: 'all' | 'pilot', href: string, text: string) => (
    <Link
      href={href}
      aria-current={current === key ? 'page' : undefined}
      className={
        current === key
          ? 'inline-flex min-h-control items-center border-b-2 border-primary px-3 text-sm font-semibold text-foreground'
          : 'inline-flex min-h-control items-center border-b-2 border-transparent px-3 text-sm font-medium text-secondary-foreground hover:text-foreground'
      }
    >
      {text}
    </Link>
  );
  return (
    <nav aria-label={label} className="flex gap-1 overflow-x-auto border-b border-border">
      {tab('all', `/agent/metrics${query ? `?${query}` : ''}`, allLabel)}
      {tab('pilot', `/agent/metrics/pilot${query ? `?${query}` : ''}`, pilotLabel)}
    </nav>
  );
}
