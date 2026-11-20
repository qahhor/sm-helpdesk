import type { ComponentProps } from 'react';
import { cn } from '@/ui/cn';

/** Подпись поля формы. Всегда видима: подсказка внутри поля подпись не заменяет. */
export function Label({ className, ...props }: ComponentProps<'label'>) {
  return <label className={cn('text-sm font-medium text-foreground', className)} {...props} />;
}
