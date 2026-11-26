'use client';

import { useState } from 'react';
import { voteAction } from './actions';

// Кнопка голоса на доске и странице идеи (FR-IDEA-04; план M7, задача 5): отклик сразу, откат и текст ошибки, если
// сервер не принял голос. Число рядом со стрелкой: голоса (или организации в режиме per_org) после ответа сервера.
// Код маленький: бюджет скриптов телефона (ТЗ 8.9).

export type VoteLabels = { vote: string; voted: string; count: string; error: string };

export function VoteButton({ number, voted, count, disabled, labels }: { number: number; voted: boolean; count: number; disabled?: boolean; labels: VoteLabels }) {
  const [state, setState] = useState({ voted, count });
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const toggle = () => {
    const before = state;
    const next = !state.voted;
    setFailed(false);
    setBusy(true);
    setState({ voted: next, count: Math.max(0, state.count + (next ? 1 : -1)) });
    voteAction({ number, vote: next })
      .catch(() => ({ error: 'failed' }))
      .then((result) => {
        setBusy(false);
        if ('error' in result) {
          setState(before);
          setFailed(true);
        } else setState({ voted: result.voted, count: result.voteCount });
      });
  };
  return (
    <div className="flex flex-col items-center gap-1">
      <button
        type="button"
        onClick={toggle}
        disabled={disabled || busy}
        aria-pressed={state.voted}
        aria-label={`${state.voted ? labels.voted : labels.vote}. ${labels.count.replace('{count}', String(state.count))}`}
        data-testid="vote-button"
        className={`flex min-h-control min-w-control flex-col items-center justify-center rounded-control border px-2 py-1 font-semibold tabular-nums focus-visible:outline-2 focus-visible:outline-ring disabled:cursor-not-allowed disabled:opacity-60 ${
          state.voted ? 'border-primary bg-primary text-primary-foreground' : 'border-border bg-card text-foreground hover:bg-card-soft'
        }`}
      >
        <span aria-hidden="true">^</span>
        <span>{state.count}</span>
      </button>
      {failed && (
        <span role="alert" className="text-center text-xs text-destructive-on-bg">
          {labels.error}
        </span>
      )}
    </div>
  );
}
