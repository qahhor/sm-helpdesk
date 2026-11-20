'use client';

import { Link, usePathname } from '@/i18n/navigation';
import { cn } from '@/ui/cn';
import { type ClientNavItem, isActive } from './nav-config';
import { NAV_ICONS } from './nav-icons';

/**
 * Навигация телефона: панель внизу экрана, под большим пальцем. Видна до 600 px.
 * Текущий раздел отмечен полосой и насыщенностью шрифта, а не только цветом.
 */
export function BottomNav({ items, label }: { items: ClientNavItem[]; label: string }) {
  const pathname = usePathname();
  return (
    <nav
      aria-label={label}
      data-nav="bottom"
      className="fixed inset-x-0 bottom-0 z-40 flex border-t border-border bg-card pb-[env(safe-area-inset-bottom)] tablet:hidden"
    >
      {items.map((item) => {
        const active = isActive(pathname, item.href);
        const Icon = NAV_ICONS[item.key];
        return (
          <Link
            key={item.key}
            href={item.href}
            aria-current={active ? 'page' : undefined}
            className={cn(
              'relative flex min-h-14 min-w-0 flex-1 flex-col items-center justify-center gap-0.5 text-xs outline-none',
              'focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring',
              active ? 'font-bold text-link' : 'font-medium text-secondary-foreground',
            )}
          >
            {active && <span aria-hidden className="absolute inset-x-4 top-0 h-0.5 rounded-chip bg-primary" />}
            <Icon className="size-6" strokeWidth={2} aria-hidden />
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}
