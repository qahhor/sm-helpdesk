'use client';

import { Globe } from 'lucide-react';
import { lazy, Suspense, useState } from 'react';
import type { Locale } from '@/i18n/locales';
import { LABELLED_TRIGGER } from './menu-trigger';

// Само меню (Radix) весит около 40 КБ и нужно редко, поэтому в первый экран не входит:
// код подгружается, когда посетитель навёл указатель, перешёл на кнопку с клавиатуры или нажал её.
const loadMenu = () => import('./LanguageMenu');
const LanguageMenu = lazy(loadMenu);

/**
 * Выбор языка. Кнопка называет текущий язык, в меню языки названы каждый на себе.
 * Выбор запоминается на год (FR-I18N-06).
 */
export function LanguageSwitcher({ locale, names, label }: { locale: Locale; names: Record<Locale, string>; label: string }) {
  const [opened, setOpened] = useState(false);

  const content = (
    <>
      <Globe className="size-5" aria-hidden />
      {/* На телефоне в шапке остаётся значок, название языка читает программа экранного доступа. */}
      <span className="max-tablet:sr-only">{names[locale]}</span>
    </>
  );
  const button = (
    <button
      type="button"
      title={label}
      aria-haspopup="menu"
      aria-expanded={false}
      aria-busy={opened}
      className={LABELLED_TRIGGER}
      onPointerEnter={loadMenu}
      onFocus={loadMenu}
      onClick={() => setOpened(true)}
    >
      {content}
    </button>
  );

  if (!opened) return button;
  return (
    <Suspense fallback={button}>
      <LanguageMenu locale={locale} names={names} label={label}>
        {content}
      </LanguageMenu>
    </Suspense>
  );
}
