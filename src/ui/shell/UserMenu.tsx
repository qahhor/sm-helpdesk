'use client';

import { CircleUserRound, LogOut } from 'lucide-react';
import { useTransition } from 'react';
import { Link } from '@/i18n/navigation';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/ui/components/dropdown-menu';
import { LABELLED_TRIGGER } from '@/ui/menu-trigger';

export type UserMenuLink = { href: string; label: string };

/**
 * Меню пользователя в шапке: имя, ссылки на свои разделы и выход.
 * Имя приходит с сервера из проверенной сессии. Выход это серверное действие.
 */
export function UserMenu({
  name,
  label,
  links,
  signOutLabel,
  signOut,
}: {
  name: string;
  label: string;
  links: UserMenuLink[];
  signOutLabel: string;
  signOut: () => Promise<void>;
}) {
  const [pending, startTransition] = useTransition();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger title={label} aria-busy={pending} className={LABELLED_TRIGGER}>
        <CircleUserRound className="size-5" aria-hidden />
        {/* На телефоне в шапке остаётся значок, имя читает программа экранного доступа. */}
        <span className="max-w-40 truncate max-tablet:sr-only">{name}</span>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" aria-label={label}>
        {links.map((link) => (
          <DropdownMenuItem key={link.href} asChild>
            <Link href={link.href}>{link.label}</Link>
          </DropdownMenuItem>
        ))}
        {links.length > 0 && <DropdownMenuSeparator />}
        <DropdownMenuItem onSelect={() => startTransition(() => signOut())}>
          <LogOut className="size-4" aria-hidden />
          {signOutLabel}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
