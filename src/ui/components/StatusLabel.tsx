import type { ReactNode } from 'react';
import { cn } from '@/ui/cn';

// Метка статуса. Шесть тонов из Smartup Web и тон "опасность".
// В тёмной теме метка без заливки: светлый текст и рамка того же цвета.
const TONES = {
  gray: 'bg-label-gray-bg text-label-gray-fg',
  green: 'bg-label-green-bg text-label-green-fg',
  orange: 'bg-label-orange-bg text-label-orange-fg',
  purple: 'bg-label-purple-bg text-label-purple-fg',
  blue: 'bg-label-blue-bg text-label-blue-fg',
  teal: 'bg-label-teal-bg text-label-teal-fg',
  danger: 'bg-destructive-bg text-destructive-on-bg',
} as const;

export type StatusTone = keyof typeof TONES;

/** Статус сообщается текстом, а не только цветом (WCAG 1.4.1). */
export function StatusLabel({ tone, children, className }: { tone: StatusTone; children: ReactNode; className?: string }) {
  return (
    <span
      className={cn(
        'inline-flex items-center whitespace-nowrap rounded-chip border border-transparent px-2.5 py-0.5 text-xs font-semibold dark:border-current',
        TONES[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}
