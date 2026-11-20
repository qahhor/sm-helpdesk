'use client';

import { type ReactNode, useTransition } from 'react';
import { chooseLocale } from '@/i18n/actions';
import type { Locale } from '@/i18n/locales';
import { usePathname } from '@/i18n/navigation';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/ui/components/dropdown-menu';
import { LABELLED_TRIGGER } from './menu-trigger';

/** Меню выбора языка. Подгружается при первом обращении к кнопке (LanguageSwitcher) и сразу открыто. */
export default function LanguageMenu({
  locale,
  names,
  label,
  children,
}: {
  locale: Locale;
  names: Record<Locale, string>;
  label: string;
  children: ReactNode;
}) {
  const pathname = usePathname();
  const [pending, startTransition] = useTransition();

  return (
    <DropdownMenu defaultOpen>
      <DropdownMenuTrigger aria-busy={pending} title={label} className={LABELLED_TRIGGER}>
        {children}
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
