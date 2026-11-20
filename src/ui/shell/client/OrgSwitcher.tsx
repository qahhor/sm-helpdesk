'use client';

import { Building2, ChevronDown } from 'lucide-react';
import { lazy, Suspense, useState } from 'react';
import { cn } from '@/ui/cn';
import { LABELLED_TRIGGER } from '@/ui/menu-trigger';

export type OrgOption = { id: string; name: string };

const loadMenu = () => import('./OrgMenu');
const OrgMenu = lazy(loadMenu);

/**
 * Активная организация в шапке кабинета (FR-ID-05). Одна организация: только название.
 * Несколько: название открывает меню выбора. Список и текущая организация приходят с сервера
 * из проверенного членства, выбор проверяет серверное действие.
 *
 * На телефоне в шапке нет места для названия: при нескольких организациях остаётся значок,
 * при одной название видит только программа экранного доступа.
 */
export function OrgSwitcher({
  current,
  orgs,
  label,
  switchAction,
}: {
  current: OrgOption;
  orgs: OrgOption[];
  label: string;
  switchAction: (form: FormData) => Promise<void>;
}) {
  const [opened, setOpened] = useState(false);
  const content = (
    <>
      <Building2 className="size-5 shrink-0" aria-hidden />
      <span className="min-w-0 max-w-64 truncate max-tablet:sr-only">{current.name}</span>
    </>
  );

  if (orgs.length < 2)
    return (
      <span className="inline-flex min-w-0 items-center gap-2 px-3 text-sm font-medium max-tablet:sr-only">{content}</span>
    );

  const button = (
    <button
      type="button"
      title={label}
      aria-haspopup="menu"
      aria-expanded={false}
      aria-busy={opened}
      className={cn(LABELLED_TRIGGER, 'min-w-0 max-w-full')}
      onPointerEnter={loadMenu}
      onFocus={loadMenu}
      onClick={() => setOpened(true)}
    >
      {content}
      <ChevronDown className="size-4 shrink-0 max-tablet:hidden" aria-hidden />
    </button>
  );
  if (!opened) return button;
  return (
    <Suspense fallback={button}>
      <OrgMenu currentId={current.id} orgs={orgs} label={label} switchAction={switchAction}>
        {content}
      </OrgMenu>
    </Suspense>
  );
}
