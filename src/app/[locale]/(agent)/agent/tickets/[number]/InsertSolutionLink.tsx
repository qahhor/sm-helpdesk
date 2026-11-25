'use client';

import { Button } from '@/ui/components/button';
import { COMPOSER_INSERT } from './Composer';

// Вставка ссылки на решение в поле ответа (FR-AG-05): то же событие, что у шаблонов из палитры.
export function InsertSolutionLink({ text, label }: { text: string; label: string }) {
  return (
    <Button type="button" variant="secondary" size="small" onClick={() => window.dispatchEvent(new CustomEvent(COMPOSER_INSERT, { detail: { text, fallback: false } }))}>
      {label}
    </Button>
  );
}
