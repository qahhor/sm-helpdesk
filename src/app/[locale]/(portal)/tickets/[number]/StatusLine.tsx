import { Check } from 'lucide-react';
import { cn } from '@/ui/cn';

// Линейка состояния обращения (UX-C-05, FR-TK-17): Создано, В работе, Решено, текущий шаг и чей ход.
// Шаг отмечен текстом и значком, а не только цветом.

export type StatusLineLabels = { label: string; created: string; work: string; resolved: string; current: string; turn: string };

const STEP_OF: Record<string, number> = { new: 0, in_progress: 1, waiting_customer: 1, in_development: 1, resolved: 2, closed: 2 };

export function StatusLine({ status, labels }: { status: string; labels: StatusLineLabels }) {
  const current = STEP_OF[status] ?? 0;
  const steps = [labels.created, labels.work, labels.resolved];
  return (
    <div className="flex flex-col gap-2">
      <ol aria-label={labels.label} className="grid grid-cols-3 gap-2">
        {steps.map((step, index) => (
          <li
            key={step}
            aria-current={index === current ? 'step' : undefined}
            className={cn(
              'flex min-w-0 flex-col gap-1 border-t-4 pt-2 text-sm',
              index <= current ? 'border-primary font-semibold text-foreground' : 'border-border text-muted-foreground',
            )}
          >
            <span className="inline-flex items-center gap-1">
              {index < current && <Check className="size-4 shrink-0" aria-hidden />}
              <span className="break-words">{step}</span>
            </span>
            {index === current && <span className="text-xs font-normal text-muted-foreground">{labels.current}</span>}
          </li>
        ))}
      </ol>
      <p className="font-semibold">{labels.turn}</p>
    </div>
  );
}
