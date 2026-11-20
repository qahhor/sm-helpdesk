import type { ComponentProps } from 'react';
import { cn } from '@/ui/cn';

/** Поле ввода: высота 46 px, как поле с подписью в Smartup Web. */
export function Input({ className, type = 'text', ...props }: ComponentProps<'input'>) {
  return (
    <input
      type={type}
      className={cn(
        'h-field w-full min-w-0 rounded-control border border-input bg-card px-3 text-base text-foreground outline-none',
        'placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30',
        'disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive',
        className,
      )}
      {...props}
    />
  );
}
