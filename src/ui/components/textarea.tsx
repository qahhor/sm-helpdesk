import type { ComponentProps } from 'react';
import { cn } from '@/ui/cn';

/** Многострочное поле: те же рамка, фон и фокус, что у поля ввода. Высота растёт по содержимому. */
export function Textarea({ className, ...props }: ComponentProps<'textarea'>) {
  return (
    <textarea
      className={cn(
        'field-sizing-content min-h-32 w-full min-w-0 rounded-control border border-input bg-card px-3 py-2 text-base text-foreground outline-none',
        'placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30',
        'disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive',
        className,
      )}
      {...props}
    />
  );
}
