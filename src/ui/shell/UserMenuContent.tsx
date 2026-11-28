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
import { clearDeviceData } from '@/ui/drafts';
import { LABELLED_TRIGGER } from '@/ui/menu-trigger';
import type { UserMenuLink } from './UserMenu';

/** Само меню пользователя. Подгружается при первом обращении к кнопке (UserMenu) и сразу открыто. */
export default function UserMenuContent({
  label,
  name,
  detail,
  links,
  signOutLabel,
  signOut,
  children,
}: {
  label: string;
  /** Имя и организация первой строкой меню на телефоне: в шапке там только значок (проверка интерфейса, U26). */
  name: string;
  detail?: string;
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
        <div className="flex flex-col px-3 py-2 tablet:hidden" data-testid="user-menu-who">
          <span className="font-semibold wrap-anywhere">{name}</span>
          {detail && <span className="text-sm text-secondary-foreground wrap-anywhere">{detail}</span>}
        </div>
        <DropdownMenuSeparator className="tablet:hidden" />
        {links.map((link) => (
          <DropdownMenuItem key={link.href} asChild>
            <Link href={link.href}>{link.label}</Link>
          </DropdownMenuItem>
        ))}
        {links.length > 0 && <DropdownMenuSeparator />}
        {/* Перед выходом с устройства убираются черновики и другие записи портала (ASVS 5.0.0, 14.3.1). */}
        <DropdownMenuItem
          onSelect={() => {
            clearDeviceData();
            startTransition(() => signOut());
          }}
        >
          <LogOut className="size-4" aria-hidden />
          {signOutLabel}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
