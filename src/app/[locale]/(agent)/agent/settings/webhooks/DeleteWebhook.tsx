'use client';

import { Button } from '@/ui/components/button';
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle, DialogTrigger } from '@/ui/components/dialog';
import { deleteWebhookAction } from './actions';

// Удаление адреса вебхука с подтверждением: окно поверх страницы, фокус внутри, Esc закрывает.

export type DeleteWebhookLabels = { open: string; title: string; text: string; confirm: string; cancel: string; close: string };

export function DeleteWebhook({ endpointId, labels }: { endpointId: string; labels: DeleteWebhookLabels }) {
  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button variant="danger" className="self-start">
          {labels.open}
        </Button>
      </DialogTrigger>
      <DialogContent closeLabel={labels.close}>
        <DialogTitle>{labels.title}</DialogTitle>
        <DialogDescription>{labels.text}</DialogDescription>
        <form action={deleteWebhookAction} className="flex flex-wrap justify-end gap-2">
          <input type="hidden" name="endpointId" value={endpointId} />
          <DialogClose asChild>
            <Button variant="secondary">{labels.cancel}</Button>
          </DialogClose>
          <Button type="submit" variant="danger">
            {labels.confirm}
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}
