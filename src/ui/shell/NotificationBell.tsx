'use client';

import { Bell } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link, usePathname } from '@/i18n/navigation';
import { ICON_TRIGGER } from '@/ui/menu-trigger';
import { bellText } from './bell-text';

/**
 * Колокольчик в шапке (FR-NT-03, решение 5 вехи M4): счётчик непрочитанных уведомлений, ссылка на список.
 * Начальное число приходит с сервера из проверенной сессии. Раскладка при переходе между страницами
 * не перерисовывается, поэтому на каждом переходе число запрашивается серверным действием заново.
 */
export function NotificationBell({
  href,
  initialCount,
  labels,
  refresh,
}: {
  href: string;
  initialCount: number;
  /** Подпись для экранного диктора по числу непрочитанных: готовые строки с сервера. */
  labels: { none: string; some: string };
  refresh: () => Promise<number>;
}) {
  const pathname = usePathname();
  const [count, setCount] = useState(initialCount);
  useEffect(() => {
    let active = true;
    refresh()
      .then((value) => {
        if (active) setCount(value);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [pathname, refresh]);
  const { label, badge } = bellText(count, labels);
  return (
    <Link href={href} aria-label={label} title={label} data-unread={count} className={`${ICON_TRIGGER} relative`}>
      <Bell className="size-5" aria-hidden />
      {badge && (
        <span
          aria-hidden
          className="absolute end-1 top-1 inline-flex min-w-5 items-center justify-center rounded-chip bg-primary px-1 text-xs font-bold text-primary-foreground"
        >
          {badge}
        </span>
      )}
    </Link>
  );
}
