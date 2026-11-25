'use client';

import { useEffect, useRef, useState } from 'react';
import { Link } from '@/i18n/navigation';
import { Button } from '@/ui/components/button';
import { voteAction } from '../actions';

// Блок "Похожие идеи" на форме подачи (FR-IDEA-02; план M7, задача 3, решение 23). После трёх слов заголовка или
// описания запрос уходит через 400 мс после последнего знака, ответ старее последнего запроса отбрасывается. Голос
// ставится без ухода со страницы: отклик сразу, откат при ошибке. Код маленький: бюджет скриптов телефона (ТЗ 8.9).

const DELAY_MS = 400;
const MIN_WORDS = 3;
const MAX = 500;

type Item = { number: number; title: string; voteCount: number; status: string; voted: boolean; isMachine: boolean };

export type SimilarLabels = { title: string; votes: string; vote: string; voted: string; machine: string; error: string };

const words = (text: string) => text.split(/[\s\p{P}]+/u).filter(Boolean).length;

export function SimilarIdeas({ text, locale, labels }: { text: string; locale: string; labels: SimilarLabels }) {
  const [items, setItems] = useState<Item[]>([]);
  const [error, setError] = useState<number | null>(null);
  const last = useRef(0);
  const query = text.trim().slice(0, MAX);
  const enough = words(query) >= MIN_WORDS;

  useEffect(() => {
    const id = ++last.current;
    if (!enough) return;
    const timer = setTimeout(() => {
      fetch(`/api/ideas/similar?${new URLSearchParams({ text: query, locale })}`, { headers: { Accept: 'application/json' } })
        .then((response) => (response.ok ? (response.json() as Promise<{ items: Item[] }>) : { items: [] }))
        .catch(() => ({ items: [] }))
        .then(({ items: found }) => {
          if (id === last.current) setItems(found);
        });
    }, DELAY_MS);
    return () => clearTimeout(timer);
  }, [query, locale, enough]);

  const visible = enough ? items : [];
  const toggle = (item: Item) => {
    const next = !item.voted;
    const patch = (change: Partial<Item>) => setItems((list) => list.map((i) => (i.number === item.number ? { ...i, ...change } : i)));
    setError(null);
    patch({ voted: next, voteCount: item.voteCount + (next ? 1 : -1) });
    voteAction({ number: item.number, vote: next })
      .catch(() => ({ error: 'failed' }))
      .then((result) => {
        if ('error' in result) {
          patch({ voted: item.voted, voteCount: item.voteCount });
          setError(item.number);
        } else patch(result);
      });
  };

  return (
    <div aria-live="polite">
      {visible.length > 0 && (
        <section aria-labelledby="similar-title" className="flex flex-col gap-2" data-testid="similar-ideas">
          <h2 id="similar-title" className="font-semibold">
            {labels.title}
          </h2>
          <ul className="flex flex-col gap-2">
            {visible.map((item) => (
              <li key={item.number} className="flex flex-col gap-2 rounded-card border border-border bg-card p-3 tablet:flex-row tablet:items-center tablet:justify-between">
                <div className="flex min-w-0 flex-col gap-1">
                  <Link href={`/ideas/${item.number}`} className="font-medium text-link underline-offset-2 hover:underline">
                    {item.title}
                  </Link>
                  <p className="text-sm text-secondary-foreground">
                    {labels.votes.replace('{count}', String(item.voteCount))}
                    {item.isMachine && <span> · {labels.machine}</span>}
                  </p>
                  {error === item.number && <p className="text-sm text-destructive-on-bg">{labels.error}</p>}
                </div>
                {(item.status === 'open' || item.status === 'shortlisted') && (
                  <Button type="button" size="small" variant={item.voted ? 'secondary' : 'primary'} aria-pressed={item.voted} onClick={() => toggle(item)}>
                    {item.voted ? labels.voted : labels.vote}
                  </Button>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
