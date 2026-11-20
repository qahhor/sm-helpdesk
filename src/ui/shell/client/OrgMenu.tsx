'use client';

import { ChevronDown } from 'lucide-react';
import { type ReactNode, useTransition } from 'react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@/ui/components/dropdown-menu';
import { cn } from '@/ui/cn';
import { LABELLED_TRIGGER } from '@/ui/menu-trigger';
import type { OrgOption } from './OrgSwitcher';

/** Меню выбора организации. Подгружается при первом обращении к кнопке (OrgSwitcher) и сразу открыто. */
export default function OrgMenu({
  currentId,
  orgs,
  label,
  switchAction,
  children,
}: {
  currentId: string;
  orgs: OrgOption[];
  label: string;
  switchAction: (form: FormData) => Promise<void>;
  children: ReactNode;
}) {
  const [pending, startTransition] = useTransition();
  const choose = (orgId: string) => {
    if (orgId === currentId) return;
    const form = new FormData();
    form.set('orgId', orgId);
    startTransition(() => switchAction(form));
  };
  return (
    <DropdownMenu defaultOpen>
      <DropdownMenuTrigger title={label} aria-busy={pending} className={cn(LABELLED_TRIGGER, 'min-w-0 max-w-full')}>
        {children}
        <ChevronDown className="size-4 shrink-0 max-tablet:hidden" aria-hidden />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" aria-label={label}>
        <DropdownMenuLabel>{label}</DropdownMenuLabel>
        <DropdownMenuRadioGroup value={currentId} onValueChange={choose}>
          {orgs.map((org) => (
            <DropdownMenuRadioItem key={org.id} value={org.id}>
              <span className="max-w-64 truncate">{org.name}</span>
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
