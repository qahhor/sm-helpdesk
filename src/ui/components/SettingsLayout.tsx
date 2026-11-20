import { ChevronDown } from 'lucide-react';
import type { ReactNode } from 'react';
import { Link } from '@/i18n/navigation';
import { cn } from '@/ui/cn';

export type SettingsSection = { key: string; href: string; label: string };

/**
 * Образец "Настройки" (раздел 8.11 ТЗ): разделы слева, содержимое справа. Ниже 1024 px разделы
 * собраны в выпадающий список над содержимым. Список раскрывается и без скриптов (details).
 * current: ключ открытого раздела; пусто на общей странице настроек.
 */
export function SettingsLayout({
  sections,
  current,
  label,
  menuLabel,
  children,
}: {
  sections: SettingsSection[];
  current: string | null;
  /** Подпись области навигации для программ экранного доступа. */
  label: string;
  /** Текст кнопки выпадающего списка: какой раздел открыт. */
  menuLabel: string;
  children: ReactNode;
}) {
  const links = (
    <ul className="flex flex-col gap-1">
      {sections.map((section) => {
        const active = section.key === current;
        return (
          <li key={section.key}>
            <Link
              href={section.href}
              aria-current={active ? 'page' : undefined}
              className={cn(
                'flex min-h-control items-center rounded-control px-3 font-medium outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring',
                active ? 'bg-selected text-selected-foreground' : 'text-foreground',
              )}
            >
              {section.label}
            </Link>
          </li>
        );
      })}
    </ul>
  );
  return (
    <div className="flex flex-col gap-4 laptop:flex-row laptop:items-start laptop:gap-6">
      <nav aria-label={label} className="laptop:hidden">
        <details className="group rounded-control border border-border bg-card">
          <summary className="flex min-h-control cursor-pointer list-none items-center justify-between gap-2 px-3 font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring">
            {menuLabel}
            <ChevronDown className="size-4 shrink-0 transition-transform group-open:rotate-180" aria-hidden />
          </summary>
          <div className="border-t border-border p-2">{links}</div>
        </details>
      </nav>
      <nav aria-label={label} className="hidden w-settings-nav shrink-0 laptop:block">
        {links}
      </nav>
      <div className="flex min-w-0 flex-1 flex-col gap-4">{children}</div>
    </div>
  );
}
