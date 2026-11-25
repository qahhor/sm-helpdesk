'use client';

import { useEffect, useState } from 'react';
import { EmptyState } from '@/ui/components/EmptyState';
import { Button } from '@/ui/components/button';
import { StatusLabel } from '@/ui/components/StatusLabel';
import { STATUS_TONE } from '@/ui/ticket-status';
import { useWidget } from './session';

// "Мои обращения" в виджете (план M6, задача 6; FR-WG-06, решение 13): обращения пользователя в этой организации,
// новые изменения первыми, по 20 на страницу. Данные из GET /api/embed/tickets по токену виджета.

type Row = { number: number; title: string; status: keyof typeof STATUS_TONE; modifiedOn: string };

export function TicketsView() {
  const w = useWidget();
  const l = w.labels;
  const [rows, setRows] = useState<Row[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  const fetchPage = async (after: string | null): Promise<{ items: Row[]; nextCursor: string | null } | null> => {
    const response = await w.request(`/api/embed/tickets${after ? `?cursor=${encodeURIComponent(after)}` : ''}`).catch(() => null);
    return response?.ok ? ((await response.json()) as { items: Row[]; nextCursor: string | null }) : null;
  };
  const show = (page: { items: Row[]; nextCursor: string | null } | null, append: boolean) => {
    if (!page) return setFailed(true);
    setRows((current) => [...(append ? (current ?? []) : []), ...page.items]);
    setCursor(page.nextCursor);
  };

  useEffect(() => {
    let live = true;
    fetchPage(null).then((page) => live && show(page, false));
    return () => {
      live = false;
    };
    // Список загружается один раз при открытии экрана.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <section className="flex flex-col gap-3" data-testid="widget-tickets">
      <h1 className="text-xl font-bold">{l['tickets.title']}</h1>
      {failed && <p className="text-sm text-destructive-on-bg">{l['report.errors.failed']}</p>}
      {rows === null && !failed && <p role="status" className="text-secondary-foreground">{l['panel.waiting']}</p>}
      {rows?.length === 0 && <EmptyState title={l['tickets.emptyTitle'] ?? ''} text={l['tickets.emptyText'] ?? ''} />}
      {rows && rows.length > 0 && (
        <ul className="flex flex-col gap-2">
          {rows.map((row) => (
            <li key={row.number}>
              <button
                type="button"
                onClick={() => w.nav.ticket(row.number)}
                className="flex w-full flex-col items-start gap-1 rounded-card border border-border bg-card p-3 text-start hover:bg-card-soft"
              >
                <span className="text-sm text-secondary-foreground">SUP-{row.number}</span>
                <span className="font-medium break-words">{row.title}</span>
                <StatusLabel tone={STATUS_TONE[row.status]}>{l[`statuses.${row.status}`]}</StatusLabel>
              </button>
            </li>
          ))}
        </ul>
      )}
      {cursor && (
        <Button variant="secondary" onClick={() => void fetchPage(cursor).then((page) => show(page, true))}>
          {l['tickets.more']}
        </Button>
      )}
    </section>
  );
}
