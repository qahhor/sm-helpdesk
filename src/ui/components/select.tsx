import type { ComponentProps } from 'react';
import { cn } from '@/ui/cn';

/** Список выбора: те же высота, рамка и видимый фокус, что у поля ввода (Input). */
export function Select({ className, ...props }: ComponentProps<'select'>) {
  return (
    <select
      className={cn(
        'h-field w-full min-w-0 rounded-control border border-input bg-card px-3 text-base text-foreground outline-none',
        'focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30',
        'disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive',
        className,
      )}
      {...props}
    />
  );
}
