'use client';

import { Link, usePathname } from '@/i18n/navigation';
import { clsx as cn } from 'clsx';
import { type ClientNavItem, isActive } from './nav-config';
import { NAV_ICONS } from './nav-icons';

/** Навигация планшета и компьютера: строка под шапкой. Видна от 600 px. */
export function TopNav({ items, label }: { items: ClientNavItem[]; label: string }) {
  const pathname = usePathname();
  return (
    <nav aria-label={label} data-nav="top" className="hidden border-b border-border bg-card tablet:block">
      <div className="mx-auto flex max-w-3xl gap-1 px-4">
        {items.map((item) => {
          const active = isActive(pathname, item.href);
          const Icon = NAV_ICONS[item.key];
          return (
            <Link
              key={item.key}
              href={item.href}
              aria-current={active ? 'page' : undefined}
              className={cn(
                'inline-flex h-row items-center gap-2 border-b-2 px-3 text-sm outline-none',
                'focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring',
                active
                  ? 'border-primary font-bold text-link'
                  : 'border-transparent font-medium text-secondary-foreground hover:text-foreground',
              )}
            >
              <Icon className="size-5" strokeWidth={2} aria-hidden />
              {item.label}
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
