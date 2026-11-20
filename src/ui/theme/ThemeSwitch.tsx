'use client';

import { Monitor, Moon, Sun } from 'lucide-react';
import { lazy, Suspense, useEffect, useState, useSyncExternalStore } from 'react';
import { ICON_TRIGGER } from '@/ui/menu-trigger';
import { DEFAULT_THEME, type Theme } from './theme';
import { applyTheme, readTheme, subscribeTheme, SYSTEM_DARK } from './theme-client';

// Само меню подгружается при первом обращении к кнопке: см. комментарий в LanguageSwitcher.
const loadMenu = () => import('./ThemeMenu');
const ThemeMenu = lazy(loadMenu);

const ICONS = { light: Sun, dark: Moon, system: Monitor } as const;

export type ThemeLabels = { label: string } & Record<Theme, string>;

/** Выбор темы оформления: светлая, тёмная или как в системе. Выбор запоминается на год. */
export function ThemeSwitch({ labels }: { labels: ThemeLabels }) {
  const theme = useSyncExternalStore(subscribeTheme, readTheme, () => DEFAULT_THEME);
  const [opened, setOpened] = useState(false);

  // Пока выбрано "как в системе", тема следует за сменой системной настройки.
  useEffect(() => {
    if (theme !== 'system') return;
    const media = window.matchMedia(SYSTEM_DARK);
    const follow = () => applyTheme('system');
    media.addEventListener('change', follow);
    return () => media.removeEventListener('change', follow);
  }, [theme]);

  const Icon = ICONS[theme];
  const icon = <Icon className="size-5" aria-hidden />;
  const button = (
    <button
      type="button"
      aria-label={labels.label}
      title={labels.label}
      aria-haspopup="menu"
      aria-expanded={false}
      aria-busy={opened}
      className={ICON_TRIGGER}
      onPointerEnter={loadMenu}
      onFocus={loadMenu}
      onClick={() => setOpened(true)}
    >
      {icon}
    </button>
  );

  if (!opened) return button;
  return (
    <Suspense fallback={button}>
      <ThemeMenu theme={theme} labels={labels}>
        {icon}
      </ThemeMenu>
    </Suspense>
  );
}
