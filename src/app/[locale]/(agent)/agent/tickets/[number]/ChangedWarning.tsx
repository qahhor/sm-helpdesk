'use client';

import type { ChangeSummary } from '@/modules/hdt/api';
import { Alert } from '@/ui/components/alert';
import { Button } from '@/ui/components/button';

// Обращение изменили, пока агент писал (FR-AG-12, UX-A-06): ответ не ушёл, видно что изменилось,
// агент решает сам: посмотреть изменения (текст сохранён в черновике) или отправить всё равно.

export type ChangedLabels = { title: string; messages: string; status: string; assignee: string; show: string; sendAnyway: string };

export function ChangedWarning({ changed, version, labels, onShow }: { changed: ChangeSummary; version: string; labels: ChangedLabels; onShow: () => void }) {
  const lines = [
    changed.newMessages > 0 ? labels.messages.replace('{count}', String(changed.newMessages)) : null,
    changed.statusChanged ? labels.status : null,
    changed.assigneeChanged ? labels.assignee : null,
  ].filter((line): line is string => line !== null);
  return (
    <Alert tone="danger">
      <p className="font-semibold">{labels.title}</p>
      <ul className="list-disc ps-5">
        {lines.map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>
      <div className="mt-2 flex flex-wrap gap-2">
        <Button type="button" variant="secondary" size="small" onClick={onShow}>
          {labels.show}
        </Button>
        <Button type="submit" name="acceptVersion" value={version} size="small">
          {labels.sendAnyway}
        </Button>
      </div>
    </Alert>
  );
}
