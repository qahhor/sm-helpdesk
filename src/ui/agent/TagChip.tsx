import type { ReactNode } from 'react';
import type { TagColor } from '@/modules/hdr/pref';
import { cn } from '@/ui/cn';

// Тег обращения (FR-AUTO-13): видят только сотрудники. Цвет хранится кодом, за кодом стоят токены оформления:
// шесть тонов меток статуса, тон "опасность" и основной цвет. В тёмной теме метка без заливки, с рамкой цвета текста.
const TONES: Record<TagColor, string> = {
  gray: 'bg-label-gray-bg text-label-gray-fg',
  green: 'bg-label-green-bg text-label-green-fg',
  orange: 'bg-label-orange-bg text-label-orange-fg',
  purple: 'bg-label-purple-bg text-label-purple-fg',
  blue: 'bg-label-blue-bg text-label-blue-fg',
  teal: 'bg-label-teal-bg text-label-teal-fg',
  red: 'bg-destructive-bg text-destructive-on-bg',
  accent: 'bg-primary text-primary-foreground',
};

/** Название тега сообщается текстом, цвет только помогает глазу (WCAG 1.4.1). */
export function TagChip({ color, children, className }: { color: TagColor; children: ReactNode; className?: string }) {
  return (
    <span
      data-tag
      className={cn(
        'inline-flex max-w-full items-center gap-1 rounded-chip border border-transparent px-2.5 py-0.5 text-xs font-semibold dark:border-current',
        TONES[color] ?? TONES.gray,
        className,
      )}
    >
      <span className="break-all">{children}</span>
    </span>
  );
}
