'use client';

import { useState } from 'react';
import { Button } from '@/ui/components/button';
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle, DialogTrigger } from '@/ui/components/dialog';
import { Input } from '@/ui/components/input';
import { Label } from '@/ui/components/label';
import { mergeAction } from './actions';

// Объединение дублей (FR-AG-07, решение 4): это обращение закрывается как дубль со ссылкой на основное.
// Номер основного проверяет сервис: та же организация, не само обращение, не закрытое, к конечному основному.

export type MergeLabels = { open: string; title: string; text: string; into: string; cancel: string; submit: string; close: string };

export function MergeDialog({ number, labels }: { number: number; labels: MergeLabels }) {
  const [into, setInto] = useState('');
  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button variant="secondary" className="w-full">
          {labels.open}
        </Button>
      </DialogTrigger>
      <DialogContent closeLabel={labels.close}>
        <DialogTitle>{labels.title}</DialogTitle>
        <DialogDescription>{labels.text}</DialogDescription>
        <form action={mergeAction} className="flex flex-col gap-4">
          <input type="hidden" name="number" value={number} />
          <div className="flex flex-col gap-1">
            <Label htmlFor="merge-into">{labels.into}</Label>
            <Input id="merge-into" name="into" required maxLength={20} placeholder="SUP-1042" value={into} onChange={(event) => setInto(event.target.value)} />
          </div>
          <div className="flex flex-wrap justify-end gap-2">
            <DialogClose asChild>
              <Button type="button" variant="secondary">
                {labels.cancel}
              </Button>
            </DialogClose>
            <Button type="submit" disabled={into.trim() === ''}>
              {labels.submit}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
