'use client';

import { ThumbsDown, ThumbsUp } from 'lucide-react';
import { useState } from 'react';
import { Link } from '@/i18n/navigation';
import { Button, buttonVariants } from '@/ui/components/button';
import { solutionFeedbackAction } from './actions';

// Кнопки "Помогло" и "Не помогло" (экран "Страница решения", ТЗ 8.3). После "Не помогло" кнопка ведёт обратно к форме
// обращения: описание там из черновика на устройстве, поля раскрыты, сессия подсказки та же (FR-SOL-11).

export function Feedback({
  number,
  sessionId,
  labels,
}: {
  number: number;
  sessionId: string | null;
  labels: { question: string; helped: string; notHelped: string; thanks: string; sorry: string; newRequest: string; failed: string };
}) {
  const [state, setState] = useState<'idle' | 'busy' | 'helped' | 'not_helped' | 'failed'>('idle');
  const send = async (outcome: 'helped' | 'not_helped') => {
    setState('busy');
    const result = await solutionFeedbackAction({ number, outcome, ...(sessionId ? { sessionId } : {}) }).catch(() => ({ ok: false }));
    setState(result.ok ? outcome : 'failed');
  };
  if (state === 'helped')
    return (
      <p role="status" className="font-medium">
        {labels.thanks}
      </p>
    );
  if (state === 'not_helped')
    return (
      <div role="status" className="flex flex-col items-start gap-2">
        <p>{labels.sorry}</p>
        <Link href={`/tickets/new?${sessionId ? `s=${sessionId}&` : ''}open=1`} className={buttonVariants()}>
          {labels.newRequest}
        </Link>
      </div>
    );
  return (
    <div className="flex flex-col gap-2" data-testid="solution-feedback">
      <p className="font-medium">{labels.question}</p>
      <div className="flex flex-wrap gap-2">
        <Button variant="secondary" disabled={state === 'busy'} onClick={() => send('helped')}>
          <ThumbsUp className="size-4" aria-hidden="true" />
          {labels.helped}
        </Button>
        <Button variant="secondary" disabled={state === 'busy'} onClick={() => send('not_helped')}>
          <ThumbsDown className="size-4" aria-hidden="true" />
          {labels.notHelped}
        </Button>
      </div>
      {state === 'failed' && (
        <p role="alert" className="text-sm text-destructive-on-bg">
          {labels.failed}
        </p>
      )}
    </div>
  );
}
