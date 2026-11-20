'use client';

import type { ReactNode } from 'react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@/ui/components/dropdown-menu';
import { ICON_TRIGGER } from '@/ui/menu-trigger';
import { isTheme, type Theme, THEMES } from './theme';
import { chooseTheme } from './theme-client';
import type { ThemeLabels } from './ThemeSwitch';

/** Меню выбора темы. Подгружается при первом обращении к кнопке (ThemeSwitch) и сразу открыто. */
export default function ThemeMenu({ theme, labels, children }: { theme: Theme; labels: ThemeLabels; children: ReactNode }) {
  return (
    <DropdownMenu defaultOpen>
      <DropdownMenuTrigger aria-label={labels.label} title={labels.label} className={ICON_TRIGGER}>
        {children}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" aria-label={labels.label}>
        <DropdownMenuRadioGroup value={theme} onValueChange={(value) => isTheme(value) && chooseTheme(value)}>
          {THEMES.map((value) => (
            <DropdownMenuRadioItem key={value} value={value}>
              {labels[value]}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
