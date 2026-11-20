import type { ComponentProps } from 'react';
import { cn } from '@/ui/cn';

/** Заготовка на месте содержимого, пока оно загружается. При настройке "меньше движения" не мигает. */
export function Skeleton({ className, ...props }: ComponentProps<'div'>) {
  return <div aria-hidden className={cn('animate-pulse rounded-control bg-border motion-reduce:animate-none', className)} {...props} />;
}
