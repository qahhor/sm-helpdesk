'use client';

import { Copy } from 'lucide-react';
import { useState } from 'react';
import { Button } from './button';

/** Копирует текст одним нажатием (UX-C-11). Результат объявляется программе экранного доступа. */
export function CopyButton({ text, label, copiedLabel }: { text: string; label: string; copiedLabel: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <>
      <Button
        variant="ghost"
        size="small"
        aria-label={label}
        title={label}
        className="min-w-control"
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(text);
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
          } catch {
            setCopied(false);
          }
        }}
      >
        <Copy className="size-4" aria-hidden />
      </Button>
      <span role="status" className="text-sm text-muted-foreground">
        {copied ? copiedLabel : ''}
      </span>
    </>
  );
}
