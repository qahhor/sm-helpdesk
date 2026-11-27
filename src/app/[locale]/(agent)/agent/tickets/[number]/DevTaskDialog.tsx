'use client';

import { useState } from 'react';
import { Button } from '@/ui/components/button';
import { Dialog, DialogClose, DialogContent, DialogTitle, DialogTrigger } from '@/ui/components/dialog';
import { Input } from '@/ui/components/input';
import { Label } from '@/ui/components/label';
import { sendToDevAction } from './actions';

// "Передать в разработку" (раздел 8.4, FR-DEV-02, 03, сценарий S4; план M8, задачи 7 и 8): вторая линия, care и admin.
// Ручной режим: сотрудник вводит номер, ссылку и название задачи из таск-менеджера. Режим API: окно только
// подтверждает передачу (задачу создаёт портал) и даёт привязать существующую задачу по номеру. Проверяет всё
// сервер: форма только не даёт отправить пустое.

export type DevTaskDialogLabels = {
  open: string;
  title: string;
  text: string;
  ref: string;
  refHint: string;
  url: string;
  urlHint: string;
  taskTitle: string;
  cancel: string;
  submit: string;
  close: string;
  /** Режим API: что уйдёт в таск-менеджер, поле номера существующей задачи и подпись кнопки. */
  apiText: string;
  existingRef: string;
  existingRefHint: string;
  submitApi: string;
};

type Props = { number: number; mode: 'manual' | 'smartup'; limits: { ref: number; url: number; title: number }; labels: DevTaskDialogLabels; action?: (form: FormData) => Promise<void> };

export function DevTaskDialog({ number, mode, limits, labels, action = sendToDevAction }: Props) {
  const [ref, setRef] = useState('');
  const [url, setUrl] = useState('');
  const [title, setTitle] = useState('');
  const manual = mode === 'manual';
  const ready = !manual || (ref.trim() !== '' && url.trim() !== '' && title.trim() !== '');
  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button variant="secondary" className="w-full">
          {labels.open}
        </Button>
      </DialogTrigger>
      <DialogContent closeLabel={labels.close}>
        <DialogTitle>{labels.title}</DialogTitle>
        <form action={action} className="flex flex-col gap-4">
          <input type="hidden" name="number" value={number} />
          <p className="text-sm text-secondary-foreground">{manual ? labels.text : labels.apiText}</p>
          <div className="flex flex-col gap-1">
            <Label htmlFor="dev-task-ref">{manual ? labels.ref : labels.existingRef}</Label>
            <Input id="dev-task-ref" name="externalId" required={manual} maxLength={limits.ref} autoComplete="off" aria-describedby="dev-task-ref-hint" value={ref} onChange={(event) => setRef(event.target.value)} />
            <p id="dev-task-ref-hint" className="text-xs text-muted-foreground">
              {manual ? labels.refHint : labels.existingRefHint}
            </p>
          </div>
          {manual && (
            <>
              <div className="flex flex-col gap-1">
                <Label htmlFor="dev-task-url">{labels.url}</Label>
                <Input id="dev-task-url" name="url" type="url" inputMode="url" required maxLength={limits.url} autoComplete="off" aria-describedby="dev-task-url-hint" value={url} onChange={(event) => setUrl(event.target.value)} />
                <p id="dev-task-url-hint" className="text-xs text-muted-foreground">
                  {labels.urlHint}
                </p>
              </div>
              <div className="flex flex-col gap-1">
                <Label htmlFor="dev-task-title">{labels.taskTitle}</Label>
                <Input id="dev-task-title" name="title" required maxLength={limits.title} autoComplete="off" value={title} onChange={(event) => setTitle(event.target.value)} />
              </div>
            </>
          )}
          <div className="flex flex-wrap justify-end gap-2">
            <DialogClose asChild>
              <Button type="button" variant="secondary">
                {labels.cancel}
              </Button>
            </DialogClose>
            <Button type="submit" disabled={!ready}>
              {manual ? labels.submit : labels.submitApi}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
