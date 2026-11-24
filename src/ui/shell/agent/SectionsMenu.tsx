'use client';

import { ChevronDown, Menu } from 'lucide-react';
import { Link } from '@/i18n/navigation';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from '@/ui/components/dropdown-menu';

export type NavGroupView = { key: string; label: string; items: { key: string; href: string; label: string }[] };

const triggerClass =
  'inline-flex h-control-small items-center gap-1 rounded-control px-3 text-sm font-medium outline-none ' +
  'hover:bg-header-foreground/10 focus-visible:ring-2 focus-visible:ring-ring data-[state=open]:bg-header-foreground/10';

function Items({ group, emptyLabel }: { group: NavGroupView; emptyLabel: string }) {
  if (group.items.length === 0) return <DropdownMenuItem disabled>{emptyLabel}</DropdownMenuItem>;
  return group.items.map((item) => (
    <DropdownMenuItem key={item.key} asChild>
      <Link href={item.href}>{item.label}</Link>
    </DropdownMenuItem>
  ));
}

/**
 * Группы разделов в верхней панели. Шире 1200 px пять кнопок, у каждой своё меню.
 * При 1200 px и уже группы свёрнуты в одну кнопку "Разделы", как в Smartup Web. На телефоне у кнопки остаётся
 * значок, название читает программа экранного доступа.
 */
export function SectionsMenu({ groups, sectionsLabel, emptyLabel }: { groups: NavGroupView[]; sectionsLabel: string; emptyLabel: string }) {
  return (
    <>
      <div className="hidden items-center gap-1 nav-full:flex">
        {groups.map((group) => (
          <DropdownMenu key={group.key}>
            <DropdownMenuTrigger className={triggerClass}>
              {group.label}
              <ChevronDown className="size-4" aria-hidden />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" aria-label={group.label}>
              <Items group={group} emptyLabel={emptyLabel} />
            </DropdownMenuContent>
          </DropdownMenu>
        ))}
      </div>
      <div className="nav-full:hidden">
        <DropdownMenu>
          <DropdownMenuTrigger className={triggerClass}>
            <Menu className="size-5" aria-hidden />
            <span className="max-tablet:sr-only">{sectionsLabel}</span>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" aria-label={sectionsLabel}>
            {groups.map((group) => (
              <DropdownMenuGroup key={group.key}>
                <DropdownMenuLabel>{group.label}</DropdownMenuLabel>
                <Items group={group} emptyLabel={emptyLabel} />
              </DropdownMenuGroup>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </>
  );
}
