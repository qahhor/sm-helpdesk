'use client';

import { CircleUserRound } from 'lucide-react';
import { lazy, Suspense, useState } from 'react';
import { LABELLED_TRIGGER } from '@/ui/menu-trigger';

export type UserMenuLink = { href: string; label: string };

// Само меню (Radix) в первый экран не входит, как и меню языка: код подгружается,
// когда человек навёл указатель, перешёл на кнопку с клавиатуры или нажал её.
const loadMenu = () => import('./UserMenuContent');
const UserMenuContent = lazy(loadMenu);

/**
 * Меню пользователя в шапке: имя, ссылки на свои разделы и выход.
 * Имя приходит с сервера из проверенной сессии. Выход это серверное действие.
 */
export function UserMenu({
  name,
  detail,
  label,
  links,
  signOutLabel,
  signOut,
}: {
  name: string;
  /** Организация клиента: на телефоне показывается в меню под именем. */
  detail?: string;
  label: string;
  links: UserMenuLink[];
  signOutLabel: string;
  signOut: () => Promise<void>;
}) {
  const [opened, setOpened] = useState(false);
  const content = (
    <>
      <CircleUserRound className="size-5" aria-hidden />
      {/* На телефоне в шапке остаётся значок, имя читает программа экранного доступа. */}
      <span className="max-w-40 truncate max-tablet:sr-only">{name}</span>
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
      <UserMenuContent label={label} name={name} detail={detail} links={links} signOutLabel={signOutLabel} signOut={signOut}>
        {content}
      </UserMenuContent>
    </Suspense>
  );
}
