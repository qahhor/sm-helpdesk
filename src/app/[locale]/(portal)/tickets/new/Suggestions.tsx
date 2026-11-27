'use client';

import { useEffect, useRef, useState } from 'react';
import { Link } from '@/i18n/navigation';
import { Button } from '@/ui/components/button';
import { type SuggestItem, type SuggestResult, suggestAction, suggestNotHelpedAction } from './actions';

// Блок "Похоже, это уже решали" (экран 8.3, FR-SOL-08..13; план M5, задача 10). Запрос уходит через 400 мс после
// последнего символа, ответ старее последнего запроса отбрасывается. Код намеренно маленький: страница укладывается
// в бюджет скриптов телефона (ТЗ 8.9). Ссылка на решение несёт сессию формы (?s=): исход пишется в ту же строку.

const DELAY_MS = 400;
const MIN = 3;
const MAX = 500;

export type SuggestLabels = { title: string; exact: string; notHelped: string };

export function Suggestions({
  text,
  moduleId,
  sessionId,
  open,
  labels,
  onChange,
  onNotHelped,
  onProblem,
}: {
  text: string;
  moduleId: string;
  sessionId: string;
  open: boolean;
  labels: SuggestLabels;
  onChange: (shown: boolean) => void;
  onNotHelped: () => void;
  /** Известная проблема по сигнатуре текста (план M5c): баннер рисует форма над полями. */
  onProblem?: (problem: SuggestResult['knownProblem']) => void;
}) {
  const [items, setItems] = useState<SuggestItem[]>([]);
  const last = useRef(0);
  const query = text.trim().slice(0, MAX);
  const visible = query.length >= MIN ? items : [];
  const shown = visible.length > 0;

  useEffect(() => {
    const id = ++last.current;
    if (query.length < MIN) return;
    const timer = setTimeout(() => {
      suggestAction({ text: query, sessionId, moduleId: moduleId || null })
        .catch((): SuggestResult => ({ items: [], knownProblem: null }))
        .then((found) => {
          if (id !== last.current) return;
          setItems(found.items);
          onProblem?.(found.knownProblem);
        });
    }, DELAY_MS);
    return () => clearTimeout(timer);
    // onProblem задаёт родитель один раз.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, moduleId, sessionId]);

  // Родитель сворачивает поля, пока подсказка видна.
  useEffect(() => onChange(shown), [shown, onChange]);

  return (
    <div aria-live="polite">
      {shown && (
        <section aria-labelledby="suggest-title" className="flex flex-col gap-2" data-testid="suggestions">
          <h2 id="suggest-title" className="font-semibold">
            {labels.title}
          </h2>
          <ul className="flex flex-col gap-2">
            {visible.map((item) => (
              <li key={item.number} className="flex flex-col gap-1 rounded-card border border-border bg-card p-3">
                {item.exact && <p className="text-xs font-semibold uppercase text-secondary-foreground">{labels.exact}</p>}
                <Link href={`/help/a/${item.number}-${item.slug}?s=${sessionId}`} className="font-medium text-link underline-offset-2 hover:underline">
                  {item.title}
                </Link>
                {item.orgLabel && <p className="text-sm text-secondary-foreground">{item.orgLabel}</p>}
              </li>
            ))}
          </ul>
          {!open && (
            <Button
              type="button"
              variant="secondary"
              className="tablet:self-start"
              onClick={() => {
                onNotHelped();
                void suggestNotHelpedAction({ sessionId }).catch(() => undefined);
              }}
            >
              {labels.notHelped}
            </Button>
          )}
        </section>
      )}
    </div>
  );
}
