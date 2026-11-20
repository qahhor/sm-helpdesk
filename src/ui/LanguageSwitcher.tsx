'use client';

import { Globe } from 'lucide-react';
import { useLocale } from 'next-intl';
import { useTransition } from 'react';
import { chooseLocale } from '@/i18n/actions';
import type { Locale } from '@/i18n/locales';
import { usePathname } from '@/i18n/navigation';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/ui/components/dropdown-menu';

/**
 * Выбор языка. Кнопка называет текущий язык, в меню языки названы каждый на себе.
 * Выбор запоминается на год (FR-I18N-06).
 */
export function LanguageSwitcher({ names, label }: { names: Record<Locale, string>; label: string }) {
  const locale = useLocale() as Locale;
  const pathname = usePathname();
  const [pending, startTransition] = useTransition();

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-busy={pending}
        title={label}
        className="inline-flex min-h-control min-w-control items-center justify-center gap-2 rounded-control px-3 text-sm font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <Globe className="size-5" aria-hidden />
        {/* На телефоне в шапке остаётся значок, название языка читает программа экранного доступа. */}
        <span className="max-tablet:sr-only">{names[locale]}</span>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" aria-label={label}>
        {(Object.keys(names) as Locale[]).map((code) => (
          <DropdownMenuItem
            key={code}
            lang={code}
            aria-current={code === locale ? 'true' : undefined}
            onSelect={() => startTransition(() => chooseLocale(code, pathname))}
          >
            {names[code]}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
