'use client';

import { X } from 'lucide-react';
import type { ReactNode } from 'react';
import { TezMark } from '@/ui/brand/TezMark';
import { Button } from '@/ui/components/button';
import { cn } from '@/ui/cn';
import { useWidget, type WidgetStatus } from './session';

// Рамка панели виджета (экран "Панель виджета внутри Smartup", ТЗ 8.3; UX-S-09): заголовок, кнопка закрытия,
// вкладки "Сообщить" и "Мои обращения" (FR-WG-06) и состояния без токена: ожидание, "Нет связи" (8.13), отказ.
// Зона клиента: крупнее текст и цель нажатия не меньше 44 px, как в кабинете на телефоне.

const STATUS_TEXT: Record<Exclude<WidgetStatus, 'ready'>, string> = {
  waiting: 'panel.waiting',
  offline: 'panel.offline',
  refused: 'panel.refused',
  denied: 'panel.denied',
  expired: 'panel.expired',
  unavailable: 'panel.unavailable',
};

export function WidgetFrame({ active, children }: { active: 'report' | 'tickets'; children: ReactNode }) {
  const w = useWidget();
  const l = w.labels;
  const tab = (id: 'report' | 'tickets', label: string, go: () => void) => (
    <button
      type="button"
      onClick={go}
      aria-current={active === id ? 'page' : undefined}
      className={cn(
        'h-control flex-1 border-b-2 px-3 font-medium',
        active === id ? 'border-primary text-foreground' : 'border-transparent text-secondary-foreground hover:text-foreground',
      )}
    >
      {label}
    </button>
  );
  return (
    <div data-zone="client" className="flex min-h-dvh flex-col bg-background text-foreground" data-widget-status={w.status}>
      <header className="flex items-center justify-between gap-2 border-b border-border bg-card px-4 py-2">
        <p className="font-semibold">{l['panel.title']}</p>
        {w.close && (
          <Button variant="ghost" size="small" className="min-w-control" aria-label={l['panel.close']} onClick={w.close}>
            <X className="size-5" aria-hidden />
          </Button>
        )}
      </header>
      {w.status === 'ready' ? (
        <>
          <nav aria-label={l['panel.tabs']} className="flex border-b border-border bg-card">
            {tab('report', l['panel.tabReport'] ?? '', w.nav.report)}
            {tab('tickets', l['panel.tabTickets'] ?? '', w.nav.tickets)}
          </nav>
          <main className="flex flex-1 flex-col gap-4 p-4">{children}</main>
        </>
      ) : (
        <main className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center" role="status">
          {w.status !== 'waiting' && <TezMark size={64} />}
          <p className="max-w-prose text-secondary-foreground">{l[STATUS_TEXT[w.status]]}</p>
        </main>
      )}
    </div>
  );
}
