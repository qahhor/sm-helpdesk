import { X } from 'lucide-react';
import type { ReactNode } from 'react';
import { cn } from '@/ui/cn';

// Баннер объявления (ТЗ FR-ANN-02, 04; план M5c, задача 6): вид сообщается текстом подписи, цвет только токенами
// состояния (сбой, плановые работы, новость). Кнопка закрытия приходит от страницы: форма серверного действия в портале
// или обработчик в панели виджета. Текст только тот, что написал сотрудник.

export type AnnouncementTone = 'maintenance' | 'outage' | 'news';

const TONES: Record<AnnouncementTone, string> = {
  outage: 'border-destructive bg-destructive-bg text-destructive-on-bg',
  maintenance: 'border-warning bg-warning-bg text-foreground',
  news: 'border-border bg-card-soft text-foreground',
};

export function AnnouncementBanner({ kind, kindLabel, title, body, dismiss, className }: { kind: AnnouncementTone; kindLabel: string; title: string; body: string; dismiss?: ReactNode; className?: string }) {
  return (
    <section aria-label={`${kindLabel}: ${title}`} data-announcement={kind} className={cn('flex items-start gap-3 rounded-control border px-3 py-2 text-sm', TONES[kind], className)}>
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <p className="break-words">
          <span className="font-semibold">{kindLabel}:</span> <span className="font-semibold">{title}</span>
        </p>
        {body && <p className="whitespace-pre-wrap break-words">{body}</p>}
      </div>
      {dismiss}
    </section>
  );
}

/** Значок кнопки закрытия баннера: подпись приходит от страницы. */
export function DismissIcon() {
  return <X className="size-4" aria-hidden />;
}
