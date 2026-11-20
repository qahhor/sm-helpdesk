import { CircleAlert, CircleCheck, Info } from 'lucide-react';
import type { ReactNode } from 'react';
import { cn } from '@/ui/cn';

export type AlertTone = 'danger' | 'success' | 'info';

const TONES: Record<AlertTone, { box: string; icon: typeof Info; iconClass: string }> = {
  danger: { box: 'border-destructive bg-destructive-bg text-destructive-on-bg', icon: CircleAlert, iconClass: '' },
  success: { box: 'border-success bg-success-bg text-foreground', icon: CircleCheck, iconClass: 'text-success' },
  info: { box: 'border-border bg-card-soft text-foreground', icon: Info, iconClass: 'text-secondary-foreground' },
};

/**
 * Сообщение над формой: ошибка, успех или пояснение. Смысл несёт значок и текст, а не только цвет.
 * Ошибка объявляется программой экранного доступа сразу (role="alert"), остальное вежливо (role="status").
 */
export function Alert({ tone = 'info', children, className }: { tone?: AlertTone; children: ReactNode; className?: string }) {
  const { box, icon: Icon, iconClass } = TONES[tone];
  return (
    <div
      role={tone === 'danger' ? 'alert' : 'status'}
      className={cn('flex items-start gap-2 rounded-control border px-3 py-2 text-sm', box, className)}
    >
      <Icon className={cn('mt-0.5 size-5 shrink-0', iconClass)} aria-hidden />
      <div className="min-w-0">{children}</div>
    </div>
  );
}
