'use client';

import { Alert } from '@/ui/components/alert';
import { CopyButton } from '@/ui/components/copy-button';

// Секрет подписи вебхука сразу после создания адреса или смены секрета (план M8, решение 9). Значение живёт только
// в состоянии формы: после перезагрузки страницы его нет ни в разметке, ни на сервере в открытом виде.

export type SecretLabels = { title: string; text: string; label: string; copy: string; copied: string; howTitle: string; how: string };

export function SecretOnce({ secret, labels }: { secret: string; labels: SecretLabels }) {
  return (
    <div data-webhook-secret className="flex flex-col gap-3">
      <Alert tone="success">
        <span className="font-semibold">{labels.title}.</span> {labels.text}
      </Alert>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm text-secondary-foreground">{labels.label}:</span>
        <code data-secret-value className="wrap-anywhere rounded-control bg-card-soft px-2 py-1">
          {secret}
        </code>
        <CopyButton text={secret} label={labels.copy} copiedLabel={labels.copied} />
      </div>
      <div className="flex flex-col gap-1 text-sm text-secondary-foreground">
        <h3 className="font-semibold text-foreground">{labels.howTitle}</h3>
        <p>{labels.how}</p>
      </div>
    </div>
  );
}
