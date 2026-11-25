'use client';

import { useEffect, useState } from 'react';
import type { SolutionDoc } from '@/modules/hdk/doc-schema';
import { Alert } from '@/ui/components/alert';
import { Button } from '@/ui/components/button';
import { DocView } from '@/ui/doc/DocView';
import { fill, useWidget } from './session';

// Решение в панели виджета (план M6, задача 5; FR-SOL-11, 13, 15): текст только из hdk_published (его отдаёт
// /api/embed/solutions), документ рисует DocView компонентами, HTML не вставляется. "Помогло" и "Не помогло" пишут
// исход сессии формы. "Не помогло" возвращает к форме с уже введённым описанием.

type Loaded =
  | { kind: 'solution'; number: number; title: string; locale: string; notTranslated: boolean; doc: SolutionDoc }
  | { kind: 'archived' }
  | { kind: 'missing' }
  | { kind: 'loading' };

export function SolutionPanel({ reference, sessionId, onBack }: { reference: string; sessionId: string; onBack: () => void }) {
  const w = useWidget();
  const l = w.labels;
  const [page, setPage] = useState<Loaded>({ kind: 'loading' });
  const [answer, setAnswer] = useState<'helped' | 'failed' | null>(null);

  useEffect(() => {
    let live = true;
    w.request(`/api/embed/solutions/${encodeURIComponent(reference)}?locale=${w.locale}`)
      .then(async (response) => (response.ok ? ((await response.json()) as Loaded) : ({ kind: 'missing' } as const)))
      .catch(() => ({ kind: 'missing' }) as const)
      .then((loaded) => live && setPage(loaded));
    return () => {
      live = false;
    };
    // Решение загружается один раз на открытие.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reference]);

  const feedback = async (outcome: 'helped' | 'not_helped') => {
    const response = await w.request(`/api/embed/solutions/${encodeURIComponent(reference)}`, { body: { outcome, sessionId } }).catch(() => null);
    if (outcome === 'not_helped') return onBack();
    setAnswer(response?.ok ? 'helped' : 'failed');
  };

  return (
    <article className="flex flex-col gap-4" data-testid="widget-solution">
      <Button variant="ghost" size="small" className="self-start" onClick={onBack}>
        {l['solution.back']}
      </Button>
      {page.kind === 'loading' && <p role="status" className="text-secondary-foreground">{l['panel.waiting']}</p>}
      {(page.kind === 'missing' || page.kind === 'archived') && <Alert>{l['solution.archived']}</Alert>}
      {page.kind === 'solution' && (
        <>
          <h1 className="text-xl font-bold break-words">{page.title}</h1>
          {page.notTranslated && <Alert>{fill(l['solution.notTranslated'] ?? '', { language: l[`languages.${page.locale}`] ?? page.locale })}</Alert>}
          <div lang={page.locale}>
            <DocView doc={page.doc} labels={{ warning: l['view.warning'] ?? '', info: l['view.info'] ?? '', step: (n) => fill(l['view.step'] ?? '', { n }) }} />
          </div>
          <section className="flex flex-col gap-2 rounded-card border border-border bg-card p-4" aria-live="polite">
            {answer === 'helped' ? (
              <p>{l['feedback.thanks']}</p>
            ) : (
              <>
                <p className="font-semibold">{l['feedback.question']}</p>
                {answer === 'failed' && <p className="text-sm text-destructive-on-bg">{l['feedback.failed']}</p>}
                <div className="flex flex-wrap gap-2">
                  <Button onClick={() => void feedback('helped')}>{l['feedback.helped']}</Button>
                  <Button variant="secondary" onClick={() => void feedback('not_helped')}>
                    {l['feedback.notHelped']}
                  </Button>
                </div>
              </>
            )}
          </section>
        </>
      )}
    </article>
  );
}
