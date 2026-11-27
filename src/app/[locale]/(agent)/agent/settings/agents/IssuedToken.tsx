'use client';

import { Alert } from '@/ui/components/alert';
import { buttonVariants } from '@/ui/components/button';
import { CopyButton } from '@/ui/components/copy-button';

// Значение токена сразу после выпуска (экран 8.12, план M8b, решение 10). Значение живёт только в состоянии формы:
// после перезагрузки страницы его нет ни в разметке, ни на сервере в открытом виде.

export type IssuedTokenLabels = { title: string; text: string; label: string; copy: string; copied: string; open: string };

export function IssuedToken({ value, href, labels }: { value: string; href: string; labels: IssuedTokenLabels }) {
  return (
    <div data-agent-token className="flex flex-col gap-3">
      <Alert tone="success">
        <span className="font-semibold">{labels.title}.</span> {labels.text}
      </Alert>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm text-secondary-foreground">{labels.label}:</span>
        <code data-token-value className="wrap-anywhere rounded-control bg-card-soft px-2 py-1 font-mono">
          {value}
        </code>
        <CopyButton text={value} label={labels.copy} copiedLabel={labels.copied} />
      </div>
      <a href={href} className={buttonVariants({ variant: 'secondary', className: 'self-start' })}>
        {labels.open}
      </a>
    </div>
  );
}
