'use client';

import { useState } from 'react';
import { Button } from '@/ui/components/button';
import { Dialog, DialogClose, DialogContent, DialogTitle, DialogTrigger } from '@/ui/components/dialog';
import { Label } from '@/ui/components/label';
import { Textarea } from '@/ui/components/textarea';
import { returnAction } from './actions';

// Возврат на первую линию с пояснением (FR-LINE-04): вторая линия, care и admin. Без пояснения кнопка неактивна.

export type ReturnLabels = { open: string; title: string; explanation: string; cancel: string; submit: string; close: string };

export function ReturnDialog({ number, labels }: { number: number; labels: ReturnLabels }) {
  const [explanation, setExplanation] = useState('');
  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button variant="secondary" className="w-full">
          {labels.open}
        </Button>
      </DialogTrigger>
      <DialogContent closeLabel={labels.close}>
        <DialogTitle>{labels.title}</DialogTitle>
        <form action={returnAction} className="flex flex-col gap-4">
          <input type="hidden" name="number" value={number} />
          <div className="flex flex-col gap-1">
            <Label htmlFor="return-explanation">{labels.explanation}</Label>
            <Textarea
              id="return-explanation"
              name="explanation"
              required
              maxLength={2000}
              value={explanation}
              onChange={(event) => setExplanation(event.target.value)}
            />
          </div>
          <div className="flex flex-wrap justify-end gap-2">
            <DialogClose asChild>
              <Button type="button" variant="secondary">
                {labels.cancel}
              </Button>
            </DialogClose>
            <Button type="submit" disabled={explanation.trim() === ''}>
              {labels.submit}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
