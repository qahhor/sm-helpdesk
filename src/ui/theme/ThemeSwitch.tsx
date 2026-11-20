'use client';

import { Monitor, Moon, Sun } from 'lucide-react';
import { useEffect, useSyncExternalStore } from 'react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@/ui/components/dropdown-menu';
import { DEFAULT_THEME, isTheme, type Theme, THEME_COOKIE, THEME_COOKIE_MAX_AGE, THEMES } from './theme';

const CHANGE_EVENT = 'hub-theme-change';
const SYSTEM_DARK = '(prefers-color-scheme: dark)';

function readTheme(): Theme {
  const value = new RegExp(`(?:^|; )${THEME_COOKIE}=([a-z]+)`).exec(document.cookie)?.[1] ?? '';
  return isTheme(value) ? value : DEFAULT_THEME;
}

function applyTheme(theme: Theme) {
  const dark = theme === 'dark' || (theme === 'system' && window.matchMedia(SYSTEM_DARK).matches);
  document.documentElement.classList.toggle('dark', dark);
}

function chooseTheme(theme: Theme) {
  const secure = window.location.protocol === 'https:' ? '; secure' : '';
  document.cookie = `${THEME_COOKIE}=${theme}; path=/; max-age=${THEME_COOKIE_MAX_AGE}; samesite=lax${secure}`;
  applyTheme(theme);
  window.dispatchEvent(new Event(CHANGE_EVENT));
}

function subscribe(onChange: () => void) {
  window.addEventListener(CHANGE_EVENT, onChange);
  return () => window.removeEventListener(CHANGE_EVENT, onChange);
}

const ICONS = { light: Sun, dark: Moon, system: Monitor } as const;

/** Выбор темы оформления. Выбор запоминается на год. */
export function ThemeSwitch({ labels }: { labels: { label: string } & Record<Theme, string> }) {
  const theme = useSyncExternalStore(subscribe, readTheme, () => DEFAULT_THEME);

  // Пока выбрано "как в системе", тема следует за сменой системной настройки.
  useEffect(() => {
    if (theme !== 'system') return;
    const media = window.matchMedia(SYSTEM_DARK);
    const follow = () => applyTheme('system');
    media.addEventListener('change', follow);
    return () => media.removeEventListener('change', follow);
  }, [theme]);

  const Icon = ICONS[theme];
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label={labels.label}
        title={labels.label}
        className="inline-flex size-control items-center justify-center rounded-control outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <Icon className="size-5" aria-hidden />
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
