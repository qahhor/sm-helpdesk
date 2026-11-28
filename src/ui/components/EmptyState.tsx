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
  heading: Heading = 'h2',
  className,
}: {
  title: string;
  text: string;
  action?: ReactNode;
  withTez?: boolean;
  /** Уровень заголовка: h1, когда пустой экран и есть вся страница (не найдено). */
  heading?: 'h1' | 'h2';
  className?: string;
}) {
  return (
    <div className={cn('flex flex-col items-center gap-3 px-4 py-8 text-center', className)}>
      {withTez && <TezMark size={96} />}
      <Heading className="text-lg font-semibold">{title}</Heading>
      <p className="max-w-prose text-secondary-foreground">{text}</p>
      {action}
    </div>
  );
}
