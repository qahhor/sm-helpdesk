import type { ReactNode } from 'react';
import { TezMark } from '@/ui/brand/TezMark';
import { cn } from '@/ui/cn';

/**
 * Пустой экран: нет обращений, ничего не найдено. Говорит, что делать дальше.
 * withTez показывает крупного Теза. На экране он один (UX-B-04).
 */
export function EmptyState({
  title,
  text,
  action,
  withTez = false,
  className,
}: {
  title: string;
  text: string;
  action?: ReactNode;
  withTez?: boolean;
  className?: string;
}) {
  return (
    <div className={cn('flex flex-col items-center gap-3 px-4 py-8 text-center', className)}>
      {withTez && <TezMark size={96} />}
      <h2 className="text-lg font-semibold">{title}</h2>
      <p className="max-w-prose text-secondary-foreground">{text}</p>
      {action}
    </div>
  );
}
