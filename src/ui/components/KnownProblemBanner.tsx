import type { ReactNode } from 'react';
import { TezMark } from '@/ui/brand/TezMark';
import { cn } from '@/ui/cn';

// Баннер "Мы знаем об этой проблеме" (ТЗ 8.3 "Известная проблема в виджете", FR-KP-05, 08; план M5c, задача 4).
// Общий для панели виджета, формы нового обращения и блока в обращении клиента. Только то, что сотрудник написал для
// клиентов: публичное название, статус, обходной путь ссылкой. Состояние Теза "Внимание" (поза "Вираж", раздел 8.13)
// только через TezMark. Тексты приходят свойствами: компонент не знает каталога сообщений.

export type KnownProblemBannerProps = {
  heading: string;
  title: string;
  /** Подпись статуса: "Статус: исправляем". */
  status: string;
  body?: string;
  workaround?: { label: string; link: ReactNode } | null;
  children?: ReactNode;
  className?: string;
  testId?: string;
};

export function KnownProblemBanner({ heading, title, status, body, workaround, children, className, testId }: KnownProblemBannerProps) {
  return (
    <section aria-label={heading} className={cn('flex flex-col gap-3 rounded-card border border-warning bg-warning-bg p-4 text-foreground', className)} data-testid={testId}>
      <div className="flex items-start gap-3">
        <TezMark size={40} pose="virazh" />
        <div className="flex min-w-0 flex-col gap-1">
          <h2 className="text-sm font-semibold uppercase">{heading}</h2>
          <p className="break-words font-semibold">{title}</p>
          <p className="text-sm">{status}</p>
        </div>
      </div>
      {body && <p className="whitespace-pre-wrap break-words text-sm">{body}</p>}
      {workaround && (
        <p className="flex flex-wrap items-center gap-2 text-sm">
          <span>{workaround.label}</span>
          {workaround.link}
        </p>
      )}
      {children}
    </section>
  );
}
