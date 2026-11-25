'use client';

import { CircleAlert, CircleCheck, Info } from 'lucide-react';
import { useState } from 'react';
import type { SolutionReview } from '@/modules/hdk/api/editor';
import { Alert } from '@/ui/components/alert';
import { Button } from '@/ui/components/button';
import { Card } from '@/ui/components/card';
import { cn } from '@/ui/cn';

// Панель готовности и находки проверки (план M5, задача 4; UX-W-07, FR-SOL-04). Пункты: заголовок, модуль, шаги,
// проверка текста, отметка "Текст прочитан" для текста модели и справочный пункт "переводы актуальны". Находки
// названы текстом и ведут к блоку. Публикация с находками требует явного подтверждения; ссылка вне списка разрешённых
// доменов не публикуется вовсе.

export type ReviewLabels = {
  title: string;
  items: { title: string; module: string; steps: string; checks: string; textRead: string; translations: string };
  findingsTitle: string;
  noFindings: string;
  kinds: Record<SolutionReview['findings'][number]['kind'], string>;
  inTitle: string;
  show: string;
  blocking: string;
  filesNotClean: string;
  machine: string;
  textRead: string;
  confirm: string;
  publish: string;
  publishing: string;
  republish: string;
  saveFirst: string;
  notReady: string;
  conflict: string;
  failed: string;
  /** Сверка перевода с оригиналом (задача 6, поправка 101). */
  invariants: { title: string; hint: string; kinds: Record<SolutionReview['invariants'][number]['kind'], string>; original: string; translation: string };
};

export function ReviewPanel({
  review,
  isMachine,
  canWrite,
  canPublish,
  archived,
  saved,
  labels,
  onShow,
  onPublish,
  onTextRead,
}: {
  review: SolutionReview;
  isMachine: boolean;
  canWrite: boolean;
  canPublish: boolean;
  archived: boolean;
  /** Все правки сохранены: публикуется ровно то, что видит сотрудник. */
  saved: boolean;
  labels: ReviewLabels;
  onShow: (blockId: string | null) => void;
  onPublish: (confirmFindings: boolean) => Promise<'published' | 'not_ready' | 'conflict' | 'failed'>;
  onTextRead: () => Promise<boolean>;
}) {
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const { readiness, findings, filesNotClean, invariants } = review;
  const items = (['title', 'module', 'steps', 'checks', ...(isMachine ? (['textRead'] as const) : [])] as const).map((key) => ({ key, ok: readiness.items[key] }));
  const canSubmit = canPublish && saved && readiness.ready && filesNotClean.length === 0 && (!readiness.needsConfirm || confirmed) && !busy;

  const publish = async () => {
    setBusy(true);
    setMessage(null);
    const result = await onPublish(readiness.needsConfirm && confirmed).catch(() => 'failed' as const);
    setBusy(false);
    if (result !== 'published') setMessage(result === 'conflict' ? labels.conflict : result === 'not_ready' ? labels.notReady : labels.failed);
  };

  return (
    <Card className="flex flex-col gap-3 p-4" data-testid="solution-review" data-ready={readiness.ready ? 'yes' : 'no'}>
      <h2 className="text-lg font-semibold">{labels.title}</h2>
      <ul className="flex flex-col gap-1" aria-label={labels.title}>
        {items.map(({ key, ok }) => {
          const Icon = ok ? CircleCheck : CircleAlert;
          return (
            <li key={key} data-item={key} data-ok={ok ? 'yes' : 'no'} className="flex items-center gap-2 text-sm">
              <Icon className={cn('size-4 shrink-0', ok ? 'text-success' : 'text-destructive')} aria-hidden="true" />
              <span>{labels.items[key]}</span>
            </li>
          );
        })}
        {/* "Переводы актуальны" (UX-W-07; 0057, M5m): справочный пункт, публикацию не закрывает. */}
        {review.translationsCurrent !== null && (
          <li data-item="translations" data-ok={review.translationsCurrent ? 'yes' : 'no'} className="flex items-center gap-2 text-sm">
            {review.translationsCurrent ? (
              <CircleCheck className="size-4 shrink-0 text-success" aria-hidden="true" />
            ) : (
              <Info className="size-4 shrink-0 text-secondary-foreground" aria-hidden="true" />
            )}
            <span>{labels.items.translations}</span>
          </li>
        )}
      </ul>

      <section aria-labelledby="review-findings" className="flex flex-col gap-2">
        <h3 id="review-findings" className="font-semibold">
          {labels.findingsTitle}
        </h3>
        {findings.length === 0 ? (
          <p className="text-sm text-secondary-foreground">{labels.noFindings}</p>
        ) : (
          <ul className="flex flex-col gap-2" data-testid="solution-findings">
            {findings.map((finding, index) => (
              <li key={`${finding.kind}-${finding.blockId}-${index}`} data-kind={finding.kind} className="flex flex-wrap items-center gap-2 text-sm">
                <span className={cn('font-medium', finding.blocking && 'text-destructive-on-bg')}>{labels.kinds[finding.kind]}</span>
                <code className="break-all rounded-control bg-card-soft px-1">{finding.text}</code>
                {finding.blockId === null && <span className="text-secondary-foreground">{labels.inTitle}</span>}
                {finding.blocking && <span className="text-destructive-on-bg">{labels.blocking}</span>}
                <Button variant="ghost" size="small" onClick={() => onShow(finding.blockId)}>
                  {labels.show}
                </Button>
              </li>
            ))}
          </ul>
        )}
        {filesNotClean.length > 0 && <Alert tone="danger">{labels.filesNotClean}</Alert>}
      </section>

      {invariants.length > 0 && (
        <section aria-labelledby="review-invariants" className="flex flex-col gap-2" data-testid="solution-invariants">
          <h3 id="review-invariants" className="font-semibold">
            {labels.invariants.title}
          </h3>
          <p className="text-sm text-secondary-foreground">{labels.invariants.hint}</p>
          <ul className="flex flex-col gap-1 text-sm">
            {invariants.map((issue) => (
              <li key={issue.kind} data-kind={issue.kind} className="flex flex-col">
                <span className="font-medium text-destructive-on-bg">{labels.invariants.kinds[issue.kind]}</span>
                <span className="break-all">
                  {labels.invariants.original}: {issue.original.join(', ') || '-'}
                </span>
                <span className="break-all">
                  {labels.invariants.translation}: {issue.translation.join(', ') || '-'}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {isMachine && (
        <Alert tone="info">
          {labels.machine}{' '}
          {canWrite && (
            <Button
              variant="secondary"
              size="small"
              disabled={!saved || busy}
              onClick={async () => {
                setBusy(true);
                const ok = await onTextRead().catch(() => false);
                setBusy(false);
                if (!ok) setMessage(labels.conflict);
              }}
            >
              {labels.textRead}
            </Button>
          )}
        </Alert>
      )}

      {canPublish && (
        <div className="flex flex-col gap-2">
          {readiness.needsConfirm && (
            <label className="flex items-start gap-2 text-sm">
              <input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} className="mt-1 size-4 accent-primary" />
              <span>{labels.confirm}</span>
            </label>
          )}
          {!saved && <p className="text-sm text-secondary-foreground">{labels.saveFirst}</p>}
          <Button className="self-start" disabled={!canSubmit} onClick={publish}>
            {busy ? labels.publishing : archived ? labels.republish : labels.publish}
          </Button>
        </div>
      )}
      {message && <Alert tone="danger">{message}</Alert>}
    </Card>
  );
}
