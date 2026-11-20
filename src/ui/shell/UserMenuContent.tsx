'use client';

import { LogOut } from 'lucide-react';
import { type ReactNode, useTransition } from 'react';
import { Link } from '@/i18n/navigation';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/ui/components/dropdown-menu';
import { LABELLED_TRIGGER } from '@/ui/menu-trigger';
import type { UserMenuLink } from './UserMenu';

/** Само меню пользователя. Подгружается при первом обращении к кнопке (UserMenu) и сразу открыто. */
export default function UserMenuContent({
  label,
  links,
  signOutLabel,
  signOut,
  children,
}: {
  label: string;
  links: UserMenuLink[];
  signOutLabel: string;
  signOut: () => Promise<void>;
  children: ReactNode;
}) {
  const [pending, startTransition] = useTransition();
  return (
    <DropdownMenu defaultOpen>
      <DropdownMenuTrigger title={label} aria-busy={pending} className={LABELLED_TRIGGER}>
        {children}
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
